/**
 * @openclaw/vapi — VAPI voice channel plugin for OpenClaw.
 *
 * Registers VAPI as a first-class message channel with:
 *   - Channel identity (shows up in /channels, /status, config UI)
 *   - Webhook service (Fastify server for VAPI's custom LLM endpoint)
 *
 * Outbound calls are handled via the voice-calls skill (shell scripts).
 *
 * Architecture:
 *
 *   Caller ──► VAPI Cloud (STT) ──► POST /chat/completions ──► webhook service
 *                                                                    │
 *                    VAPI Cloud (TTS) ◄── SSE stream ◄──────────────┘
 *                         │
 *                    Caller hears speech
 */

import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk";
import fastifyFormBody from "@fastify/formbody";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import type { VapiChatRequest, VapiPluginConfig, VapiServerEvent } from "./types.js";
import { createVapiChannelPlugin } from "./channel.js";
import { OutboundManager } from "./outbound.js";
import { startStream, writeChunk, endStream, sendAndClose } from "./streaming.js";

// ─── Plugin Definition ──────────────────────────────────────────────────────

const vapiPlugin = {
  id: "vapi",
  name: "VAPI Voice Channel",
  description: "Voice calls via VAPI — inbound/outbound phone calls with real-time STT/TTS.",

  configSchema: {
    parse(value: unknown): VapiPluginConfig {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return {
        api_key: typeof raw.api_key === "string" ? raw.api_key : "",
        webhook_port: typeof raw.webhook_port === "number" ? raw.webhook_port : 3001,
        assistant_id: typeof raw.assistant_id === "string" ? raw.assistant_id : undefined,
        phone_number_id: typeof raw.phone_number_id === "string" ? raw.phone_number_id : undefined,
        default_greeting:
          typeof raw.default_greeting === "string" ? raw.default_greeting : undefined,
        host: typeof raw.host === "string" ? raw.host : undefined,
      };
    },
    uiHints: {
      api_key: { label: "VAPI API Key", sensitive: true },
      webhook_port: { label: "Webhook Port", placeholder: "3001" },
      assistant_id: { label: "Assistant ID (outbound)" },
      phone_number_id: { label: "Phone Number ID (outbound)" },
      default_greeting: { label: "Default Greeting", placeholder: "Hey! How can I help?" },
      host: { label: "Server Bind Address", placeholder: "0.0.0.0", advanced: true },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = vapiPlugin.configSchema.parse(api.pluginConfig);
    const logger = api.logger;

    let outbound: OutboundManager | null = null;
    let fastify: ReturnType<typeof Fastify> | null = null;

    // Track active calls: callId -> caller phone number
    // Populated from /chat/completions and /events, used by /api/action
    const activeCallsMap = new Map<string, string>();

    // Track most recent caller for single-call fallback
    let currentActiveCaller: string | null = null;

    // Bridge plugin logger to the shape OutboundManager expects
    const logBridge = {
      info: (...args: unknown[]) => logger.info(args.map(String).join(" ")),
      error: (...args: unknown[]) => logger.error(args.map(String).join(" ")),
    };

    // ── Channel Registration ──────────────────────────────────────────────

    const channelPlugin = createVapiChannelPlugin({
      getOutbound: () => outbound,
    });

    api.registerChannel({ plugin: channelPlugin });

    // ── Webhook Service ───────────────────────────────────────────────────
    //
    // Runs a Fastify HTTP server that receives VAPI webhooks.
    // VAPI sends transcribed speech to /chat/completions and expects
    // SSE streaming responses in OpenAI format.

    const webhookService: OpenClawPluginService = {
      id: "vapi-webhook",

      start: async () => {
        if (!config.api_key) {
          logger.warn("[vapi] No api_key configured — webhook service not started");
          return;
        }

        outbound = new OutboundManager(config, logBridge);
        fastify = Fastify();
        await fastify.register(fastifyFormBody);

        // ── POST /chat/completions ────────────────────────────────────────
        //
        // Main endpoint. VAPI sends transcribed speech here.
        // We identify the caller, route to the agent, stream the response.
        //
        //   1. VAPI transcribes caller speech
        //   2. Sends OpenAI-format messages array + call metadata
        //   3. We extract latest user message
        //   4. Build session key from caller phone number
        //   5. Route to agent via channel reply pipeline
        //   6. Stream agent tokens back as SSE chunks
        //   7. VAPI pipes chunks to TTS → caller hears response in real time

        fastify.post("/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
          const body = request.body as VapiChatRequest;
          const call = body.call;
          const callId = call?.id || randomUUID();
          const callerNumber = call?.customer?.number || "unknown";
          const isOutbound = call?.type === "outboundPhoneCall";

          logger.info(
            `[vapi] ${isOutbound ? "outbound" : "inbound"} call ${callId} from ${callerNumber}`,
          );

          // Track caller for /api/action lookups
          if (callerNumber && callerNumber !== "unknown") {
            activeCallsMap.set(callId, callerNumber);
          }

          // Extract latest user message from the conversation history
          const userMessages = body.messages?.filter((m) => m.role === "user") || [];
          const latestMessage = userMessages[userMessages.length - 1]?.content;

          // No user message yet — VAPI is asking for the initial greeting.
          // This happens when the call first connects (assistant-speaks-first mode).
          if (!latestMessage) {
            logger.info("[vapi] No user message — sending greeting");
            const greeting = config.default_greeting || "Hey! How can I help?";
            sendAndClose(reply.raw, callId, greeting);
            return;
          }

          // Start SSE stream — we'll write chunks as the agent generates tokens
          startStream(reply.raw);

          // Check for outbound call context (injected when we initiated the call)
          let systemContext: string | undefined;
          if (outbound) {
            const outboundCtx = outbound.consumeContext(callId);
            if (outboundCtx) {
              systemContext =
                `This is an outbound call you initiated to ${outboundCtx.calleeName || outboundCtx.calleeNumber}. ` +
                `Context: ${outboundCtx.context}`;
            }
          }

          try {
            // Route to the agent via the channel pipeline.
            const cfg = api.config;
            const route = api.runtime.channel.routing.resolveAgentRoute({
              cfg,
              channel: "vapi",
              peer: { kind: "direct", id: callerNumber },
            });

            // Always use a VAPI-specific session key so it doesn't share
            // sessions with Slack/email (which would route replies there).
            const sessionKey = `agent:main:vapi:dm:${callerNumber}`;

            // Build MsgContext for the inbound message
            const msgCtx = api.runtime.channel.reply.finalizeInboundContext({
              Body: latestMessage,
              From: callerNumber,
              To: callerNumber,
              SessionKey: sessionKey,
              ChatType: "direct",
              Provider: "vapi",
              Surface: "vapi",
              SenderId: callerNumber,
              SenderE164: callerNumber,
              ...(systemContext ? { UntrustedContext: [systemContext] } : {}),
            });

            // Create a dispatcher that streams SSE to the VAPI connection.
            // This replaces the normal outbound.sendText flow because VAPI
            // requires the response on the same HTTP connection.
            const { dispatcher, replyOptions, markDispatchIdle } =
              api.runtime.channel.reply.createReplyDispatcherWithTyping({
                deliver: async (payload: { text?: string }) => {
                  logger.info(
                    `[vapi] deliver called: payload=${JSON.stringify(payload)?.slice(0, 200)}`,
                  );
                  const text = payload?.text;
                  if (text) {
                    writeChunk(reply.raw, callId, text);
                  } else {
                    logger.info(`[vapi] deliver called but no text in payload`);
                  }
                },
              });

            logger.info(`[vapi] dispatching reply for session=${sessionKey}`);
            await api.runtime.channel.reply.dispatchReplyFromConfig({
              ctx: msgCtx,
              cfg,
              dispatcher,
              replyOptions,
            });
            logger.info(`[vapi] dispatch complete for call ${callId}`);

            markDispatchIdle?.();
            endStream(reply.raw, callId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[vapi] Call ${callId} agent error: ${msg}`);
            writeChunk(reply.raw, callId, "Sorry, something went wrong. Please try again.");
            endStream(reply.raw, callId);
          }
        });

        // ── POST /api/action ───────────────────────────────────────────────
        //
        // Tool endpoint for VAPI apiRequest tools. Receives natural language
        // requests and executes them via OpenClaw, returning the result.
        //
        // This enables a hybrid architecture where VAPI handles conversation
        // natively (fast) and only calls OpenClaw for actions that need tools.
        //
        // Request body:
        //   { "request": "email John about the meeting", "caller": "+91...", "callId": "..." }
        //
        // Response:
        //   { "success": true, "result": "Email sent to John about the meeting." }

        fastify.post("/api/action", async (request: FastifyRequest, reply: FastifyReply) => {
          const body = request.body as Record<string, unknown>;
          const query = request.query as Record<string, unknown>;

          // Log full request to debug what VAPI sends
          logger.info(`[vapi] Action raw body: ${JSON.stringify(body).slice(0, 500)}`);
          logger.info(`[vapi] Action query params: ${JSON.stringify(query)}`);

          const actionRequest = typeof body.request === "string" ? body.request : undefined;

          // Get callId from query/body
          const callId =
            (typeof query.callId === "string" && !query.callId.includes("{{")
              ? query.callId
              : null) ||
            (typeof body.callId === "string" && !String(body.callId).includes("{{")
              ? body.callId
              : null) ||
            randomUUID();

          // Try to get caller from: 1) query params, 2) body, 3) activeCallsMap lookup, 4) unknown
          let callerNumber =
            (typeof query.caller === "string" && !query.caller.includes("{{")
              ? query.caller
              : null) ||
            (typeof body.caller === "string" && !String(body.caller).includes("{{")
              ? body.caller
              : null);

          // If caller not provided or is a template literal, look up from active calls
          if (!callerNumber) {
            callerNumber = activeCallsMap.get(callId) || currentActiveCaller || "unknown";
            if (callerNumber !== "unknown") {
              logger.info(`[vapi] Resolved caller ${callerNumber} from tracking`);
            }
          }

          // Clean up caller number - trim whitespace and ensure + prefix
          if (callerNumber && callerNumber !== "unknown") {
            callerNumber = callerNumber.trim();
            if (!callerNumber.startsWith("+") && /^\d/.test(callerNumber)) {
              callerNumber = "+" + callerNumber;
            }
          }

          logger.info(
            `[vapi] Action request from ${callerNumber}: ${actionRequest?.slice(0, 100)}`,
          );

          if (!actionRequest) {
            return reply.status(400).send({
              success: false,
              error: "Missing 'request' field",
            });
          }

          try {
            const cfg = api.config;

            // Use a dedicated session for tool calls to avoid mixing with voice conversation
            const sessionKey = `agent:main:vapi:tool:${callerNumber}`;

            // Build context for the agent
            const toolContext = `[VAPI Tool Call] Caller phone: ${callerNumber}

You have full access to workspace files (USER.md, TOOLS.md, MEMORY.md, contacts). 
If you need to identify the caller or find their Slack/email, check these files first.
The caller's phone number can be matched to their identity in your workspace.

Execute this request and return a concise result suitable for voice response (1-2 sentences max).`;

            // Use Provider: "api" to avoid cross-context messaging restrictions
            // This allows the agent to send to email/Slack from a tool call
            const msgCtx = api.runtime.channel.reply.finalizeInboundContext({
              Body: actionRequest,
              From: callerNumber,
              To: callerNumber,
              SessionKey: sessionKey,
              ChatType: "direct",
              Provider: "api",
              Surface: "api",
              SenderId: callerNumber,
              SenderE164: callerNumber,
              UntrustedContext: [toolContext],
            });

            // Collect the response instead of streaming
            let responseText = "";

            const { dispatcher, replyOptions, markDispatchIdle } =
              api.runtime.channel.reply.createReplyDispatcherWithTyping({
                deliver: async (payload: { text?: string }) => {
                  if (payload?.text) {
                    responseText += payload.text;
                  }
                },
              });

            await api.runtime.channel.reply.dispatchReplyFromConfig({
              ctx: msgCtx,
              cfg,
              dispatcher,
              replyOptions,
            });

            markDispatchIdle?.();

            logger.info(
              `[vapi] Action completed for ${callerNumber}: ${responseText.slice(0, 100)}`,
            );

            return reply.status(200).send({
              success: true,
              result: responseText || "Action completed.",
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[vapi] Action error for ${callerNumber}: ${msg}`);
            return reply.status(500).send({
              success: false,
              error: "Failed to execute action. Please try again.",
            });
          }
        });

        // ── POST /assistant-selector ──────────────────────────────────────
        //
        // Assistant selector for inbound calls. VAPI calls this endpoint when
        // a call comes in, and we return the assistant ID + variableValues
        // with the caller's phone number so tools can identify who's calling.
        //
        // Configure in VAPI: Set "Server URL" to this endpoint.
        //
        // Request from VAPI:
        //   { "message": { "type": "assistant-request", "call": { "customer": { "number": "+91..." } } } }
        //
        // Response:
        //   { "assistantId": "...", "assistantOverrides": { "variableValues": { "callerId": "+91..." } } }

        // ── POST /server (Server URL for custom tools) ─────────────────────
        //
        // Handles all VAPI server messages including:
        // - assistant-request: Return assistant config for inbound calls
        // - tool-calls: Execute custom function tools
        // - Other events: Acknowledge
        //
        // Custom tools receive full call context including customer.number!

        fastify.post("/server", async (request: FastifyRequest, reply: FastifyReply) => {
          const body = request.body as Record<string, unknown>;
          const message = body.message as Record<string, unknown> | undefined;
          const messageType = message?.type as string | undefined;

          // Extract call info from any event type
          const call = message?.call as Record<string, unknown> | undefined;
          const callId = call?.id as string | undefined;
          const customer = call?.customer as Record<string, unknown> | undefined;
          let callerNumber = customer?.number as string | undefined;

          // Clean up caller number
          if (callerNumber) {
            callerNumber = callerNumber.trim();
            if (!callerNumber.startsWith("+") && /^\d/.test(callerNumber)) {
              callerNumber = "+" + callerNumber;
            }
          }

          logger.info(
            `[vapi] Server message: type=${messageType} caller=${callerNumber || "unknown"}`,
          );

          // Track caller for /api/action lookups (critical for api_request tools)
          if (callId && callerNumber) {
            activeCallsMap.set(callId, callerNumber);
          }
          if (callerNumber) {
            currentActiveCaller = callerNumber;
          }

          // ── Handle assistant-request ──────────────────────────────────────
          if (messageType === "assistant-request") {
            logger.info(`[vapi] Assistant request from ${callerNumber || "unknown"}`);

            return reply.status(200).send({
              assistantId: config.assistant_id,
              assistantOverrides: {
                variableValues: {
                  callerId: callerNumber || "unknown",
                },
              },
            });
          }

          // ── Handle tool-calls (custom function execution) ─────────────────
          if (messageType === "tool-calls") {
            // Debug: log the raw message structure to see what VAPI sends
            logger.info(`[vapi] Tool-calls raw message: ${JSON.stringify(message).slice(0, 1000)}`);

            // VAPI sends toolCalls (not toolCallList) with function.name and function.arguments
            const toolCallList = (message?.toolCallList || message?.toolCalls) as
              | Array<{
                  id: string;
                  name?: string;
                  function?: { name: string; arguments: Record<string, unknown> | string };
                  arguments?: Record<string, unknown>;
                }>
              | undefined;

            if (!toolCallList || toolCallList.length === 0) {
              return reply.status(200).send({ results: [] });
            }

            const results: Array<{ toolCallId: string; result: string }> = [];

            for (const toolCall of toolCallList) {
              // Handle both formats: direct (name, arguments) or nested (function.name, function.arguments)
              const toolName = toolCall.name || toolCall.function?.name;
              let toolArgs = toolCall.arguments || toolCall.function?.arguments;

              // VAPI sometimes sends arguments as a JSON string
              if (typeof toolArgs === "string") {
                try {
                  toolArgs = JSON.parse(toolArgs);
                } catch {
                  toolArgs = { request: toolArgs };
                }
              }

              const toolCallId = toolCall.id;

              logger.info(
                `[vapi] Tool call: ${toolName} from ${callerNumber || "unknown"} args=${JSON.stringify(toolArgs).slice(0, 200)}`,
              );

              // Handle do_action tool
              if (toolName === "do_action") {
                const argsObj = (toolArgs || {}) as Record<string, unknown>;
                const actionRequest = argsObj.request as string | undefined;

                if (!actionRequest) {
                  results.push({ toolCallId, result: "No request provided." });
                  continue;
                }

                try {
                  const cfg = api.config;
                  const sessionKey = `agent:main:vapi:tool:${callerNumber || "unknown"}`;

                  const toolContext = `[VAPI Tool Call] Caller phone: ${callerNumber || "unknown"}

You have full access to workspace files (USER.md, TOOLS.md, MEMORY.md, contacts). 
If you need to identify the caller or find their Slack/email, check these files first.
The caller's phone number can be matched to their identity in your workspace.

Execute this request and return a concise result suitable for voice response (1-2 sentences max).`;

                  const msgCtx = api.runtime.channel.reply.finalizeInboundContext({
                    Body: actionRequest,
                    From: callerNumber || "unknown",
                    To: callerNumber || "unknown",
                    SessionKey: sessionKey,
                    ChatType: "direct",
                    Provider: "api",
                    Surface: "api",
                    SenderId: callerNumber || "unknown",
                    SenderE164: callerNumber || "unknown",
                    UntrustedContext: [toolContext],
                  });

                  let responseText = "";
                  const { dispatcher, replyOptions, markDispatchIdle } =
                    api.runtime.channel.reply.createReplyDispatcherWithTyping({
                      deliver: async (payload: { text?: string }) => {
                        if (payload?.text) {
                          responseText += payload.text;
                        }
                      },
                    });

                  await api.runtime.channel.reply.dispatchReplyFromConfig({
                    ctx: msgCtx,
                    cfg,
                    dispatcher,
                    replyOptions,
                  });

                  markDispatchIdle?.();

                  logger.info(`[vapi] Tool completed: ${responseText.slice(0, 100)}`);
                  results.push({ toolCallId, result: responseText || "Action completed." });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  logger.error(`[vapi] Tool error: ${msg}`);
                  results.push({ toolCallId, result: "Failed to execute action." });
                }
              } else {
                // Unknown tool
                results.push({ toolCallId, result: `Unknown tool: ${toolName}` });
              }
            }

            return reply.status(200).send({ results });
          }

          // ── Handle end-of-call ────────────────────────────────────────────
          if (messageType === "end-of-call-report") {
            logger.info(`[vapi] Call ended`);
          }

          // For all other events, just acknowledge
          return reply.status(200).send({ ok: true });
        });

        // ── POST /assistant-selector ─────────────────────────────────────
        //
        // VAPI calls this endpoint when an inbound call arrives to determine
        // which assistant to use. We return the configured assistant ID and
        // inject the caller's phone number into variableValues so the
        // {{callerId}} variable is available in tool URLs (same as outbound).
        //
        fastify.post(
          "/assistant-selector",
          async (request: FastifyRequest, reply: FastifyReply) => {
            const body = request.body as Record<string, unknown>;
            const call = body?.call as Record<string, unknown> | undefined;
            const customer = call?.customer as Record<string, unknown> | undefined;
            const customerNumber = (customer?.number as string) || "unknown";

            // Use configured assistant_id, or fall back to env var
            const assistantId = config.assistant_id || process.env.VAPI_ASSISTANT_ID;

            if (!assistantId) {
              logger.error("[vapi] No assistant_id configured for inbound calls");
              return reply.status(500).send({ error: "No assistant configured" });
            }

            logger.info(`[vapi] Inbound call from ${customerNumber} → assistant ${assistantId}`);

            // Track this caller for /api/action lookups
            const callId = call?.id as string | undefined;
            if (callId && customerNumber !== "unknown") {
              activeCallsMap.set(callId, customerNumber);
              currentActiveCaller = customerNumber;
            }

            return reply.send({
              assistantId,
              assistantOverrides: {
                variableValues: {
                  callerId: customerNumber,
                },
              },
            });
          },
        );

        // ── POST /events ──────────────────────────────────────────────────
        //
        // VAPI server events: status updates, end-of-call reports, transcripts.
        // Informational — no response body needed (just 200 OK).

        fastify.post("/events", async (request: FastifyRequest, reply: FastifyReply) => {
          const event = request.body as VapiServerEvent;
          const type = event?.message?.type;
          const callId = event?.message?.call?.id;

          // Track caller from events
          const customerNumber = event?.message?.call?.customer?.number;
          if (callId && customerNumber) {
            activeCallsMap.set(callId, customerNumber);
          }

          switch (type) {
            case "end-of-call-report": {
              const report = event.message as Record<string, unknown>;
              logger.info(
                `[vapi] Call ${callId} ended — reason=${report.endedReason} duration=${report.durationSeconds}s`,
              );
              // Clean up ended call from map
              if (callId) activeCallsMap.delete(callId);
              break;
            }
            case "status-update":
              logger.info(`[vapi] Call ${callId} status: ${event.message.call?.status}`);
              break;
            case "transcript":
              break;
            default:
              logger.info(`[vapi] Event: ${type} for call ${callId}`);
          }

          reply.status(200).send({ ok: true });
        });

        // Start the server
        const port = config.webhook_port;
        const host = config.host || "0.0.0.0";
        await fastify.listen({ port, host });
        logger.info(`[vapi] Webhook server listening on ${host}:${port}`);
        logger.info(`[vapi] Custom LLM endpoint: http://${host}:${port}/chat/completions`);
        logger.info(`[vapi] Events endpoint: http://${host}:${port}/events`);
        if (config.assistant_id && config.phone_number_id) {
          logger.info("[vapi] Outbound calls enabled (via voice-calls skill)");
        }
      },

      stop: async () => {
        if (fastify) {
          await fastify.close();
          fastify = null;
          logger.info("[vapi] Webhook server stopped");
        }
        outbound = null;
      },
    };

    api.registerService(webhookService);
  },
};

export default vapiPlugin;
