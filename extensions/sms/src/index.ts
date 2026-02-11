/**
 * @openclaw/channel-sms — SMS channel plugin for OpenClaw.
 *
 * Registers SMS as a first-class message channel with:
 *   - Channel identity (shows up in /channels, /status, config UI)
 *   - Webhook service (Fastify server for Twilio inbound webhooks)
 *   - Agent tool (sms_send for outbound text messages)
 *   - Gateway RPC methods (sms.send, sms.status)
 *
 * Architecture:
 *
 *   Sender ──► Twilio ──► POST /sms/inbound ──► webhook service
 *                                                     │
 *                    Twilio API ◄── sendSms() ◄──────┘
 *                         │
 *                    Recipient receives SMS
 */

import type {
  OpenClawPluginApi,
  GatewayRequestHandlerOptions,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import fastifyFormBody from "@fastify/formbody";
import { Type } from "@sinclair/typebox";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { createHmac } from "node:crypto";
import type { TwilioInboundPayload, SmsPluginConfig } from "./types.js";
import { createSmsChannelPlugin } from "./channel.js";
import { OutboundManager } from "./outbound.js";

// ─── Twilio Signature Validation ─────────────────────────────────────────────

function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  // Sort param keys and concatenate key+value
  const data =
    url +
    Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], "");

  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  return expected === signature;
}

// ─── Plugin Definition ──────────────────────────────────────────────────────

const smsPlugin = {
  id: "sms",
  name: "SMS Channel",
  description: "Text messages via Twilio — inbound/outbound SMS with full agent integration.",

  configSchema: {
    parse(value: unknown): SmsPluginConfig {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return {
        account_sid: typeof raw.account_sid === "string" ? raw.account_sid : "",
        auth_token: typeof raw.auth_token === "string" ? raw.auth_token : "",
        phone_number: typeof raw.phone_number === "string" ? raw.phone_number : "",
        webhook_port: typeof raw.webhook_port === "number" ? raw.webhook_port : 3002,
        host: typeof raw.host === "string" ? raw.host : undefined,
        webhook_url: typeof raw.webhook_url === "string" ? raw.webhook_url : undefined,
      };
    },
    uiHints: {
      account_sid: { label: "Twilio Account SID", placeholder: "AC..." },
      auth_token: { label: "Twilio Auth Token", sensitive: true },
      phone_number: { label: "Twilio Phone Number", placeholder: "+15551234567" },
      webhook_port: { label: "Webhook Port", placeholder: "3002" },
      host: { label: "Server Bind Address", placeholder: "0.0.0.0", advanced: true },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = smsPlugin.configSchema.parse(api.pluginConfig);
    const logger = api.logger;

    let outbound: OutboundManager | null = null;
    let fastify: ReturnType<typeof Fastify> | null = null;

    const logBridge = {
      info: (...args: unknown[]) => logger.info(args.map(String).join(" ")),
      error: (...args: unknown[]) => logger.error(args.map(String).join(" ")),
    };

    // ── Channel Registration ──────────────────────────────────────────────

    const channelPlugin = createSmsChannelPlugin({
      getOutbound: () => outbound,
    });

    api.registerChannel({ plugin: channelPlugin });

    // ── Webhook Service ───────────────────────────────────────────────────
    //
    // Runs a Fastify HTTP server that receives Twilio inbound SMS webhooks.
    // Twilio POSTs form-urlencoded data to /sms/inbound when a message arrives.
    // Unlike VAPI (which streams on the same connection), SMS uses fire-and-forget:
    //   1. Receive webhook → respond immediately with empty TwiML
    //   2. Process message asynchronously
    //   3. Send reply via separate Twilio API call

    const webhookService: OpenClawPluginService = {
      id: "sms-webhook",

      start: async () => {
        if (!config.account_sid || !config.auth_token || !config.phone_number) {
          logger.warn(
            "[sms] Missing account_sid, auth_token, or phone_number — webhook service not started",
          );
          return;
        }

        outbound = new OutboundManager(config, logBridge);
        fastify = Fastify();
        await fastify.register(fastifyFormBody);

        // ── POST /sms/inbound ──────────────────────────────────────────────
        //
        // Main endpoint. Twilio sends inbound SMS here.
        //
        //   1. Twilio receives SMS from sender
        //   2. POSTs form-urlencoded payload (From, To, Body, MessageSid, etc.)
        //   3. We validate the Twilio signature
        //   4. Route to agent via channel reply pipeline
        //   5. Respond with empty TwiML immediately
        //   6. Agent reply is sent as a separate outbound SMS

        fastify.post("/sms/inbound", async (request: FastifyRequest, reply: FastifyReply) => {
          const body = request.body as TwilioInboundPayload;
          const messageSid = body.MessageSid || "unknown";
          const from = body.From || "";
          const to = body.To || "";
          const text = body.Body || "";

          logger.info(`[sms] Inbound ${messageSid} from ${from}: ${text.slice(0, 80)}`);

          // Validate Twilio signature if auth_token is configured
          const signature = request.headers["x-twilio-signature"] as string | undefined;
          if (signature && config.auth_token) {
            // Reconstruct the public URL that Twilio signed against:
            // 1. Explicit webhook_url config (most reliable for prod)
            // 2. x-forwarded-* headers (from ngrok/reverse proxy)
            // 3. Local request info (fallback)
            let webhookUrl: string;
            if (config.webhook_url) {
              const base = config.webhook_url.replace(/\/+$/, "");
              webhookUrl = `${base}${request.url}`;
            } else {
              const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol;
              const host = (request.headers["x-forwarded-host"] as string) || request.hostname;
              webhookUrl = `${proto}://${host}${request.url}`;
            }
            const params: Record<string, string> = {};
            for (const [key, value] of Object.entries(body)) {
              if (typeof value === "string") params[key] = value;
            }
            if (!validateTwilioSignature(config.auth_token, signature, webhookUrl, params)) {
              logger.warn(`[sms] Invalid Twilio signature for ${messageSid} (url=${webhookUrl})`);
              reply.status(403).send("Invalid signature");
              return;
            }
          }

          // Respond immediately with empty TwiML — Twilio expects a quick response.
          // The actual reply will be sent as a separate outbound SMS.
          reply.status(200).header("Content-Type", "text/xml").send("<Response/>");

          // Process message asynchronously
          try {
            const cfg = api.config;
            const route = api.runtime.channel.routing.resolveAgentRoute({
              cfg,
              channel: "sms",
              peer: { kind: "direct", id: from },
            });

            const sessionKey = route.sessionKey ?? `agent:main:sms:dm:${from}`;

            const msgCtx = api.runtime.channel.reply.finalizeInboundContext({
              Body: text,
              From: from,
              To: to,
              SessionKey: sessionKey,
              ChatType: "direct",
              Provider: "sms",
              Surface: "sms",
              SenderId: from,
              SenderE164: from,
            });

            const { dispatcher, replyOptions, markDispatchIdle } =
              api.runtime.channel.reply.createReplyDispatcherWithTyping({
                deliver: async (payload: { text?: string }) => {
                  const replyText = payload?.text;
                  if (replyText && outbound) {
                    await outbound.sendSms(from, replyText);
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
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[sms] Message ${messageSid} agent error: ${msg}`);
            // Best-effort error reply
            if (outbound) {
              await outbound
                .sendSms(from, "Sorry, something went wrong. Please try again.")
                .catch(() => {});
            }
          }
        });

        // Start the server
        const port = config.webhook_port;
        const host = config.host || "0.0.0.0";
        await fastify.listen({ port, host });
        logger.info(`[sms] Webhook server listening on ${host}:${port}`);
        logger.info(`[sms] Inbound endpoint: http://${host}:${port}/sms/inbound`);
        logger.info("[sms] Outbound SMS enabled (tool: sms_send)");
      },

      stop: async () => {
        if (fastify) {
          await fastify.close();
          fastify = null;
          logger.info("[sms] Webhook server stopped");
        }
        outbound = null;
      },
    };

    api.registerService(webhookService);

    // ── Agent Tool: sms_send ────────────────────────────────────────────
    //
    // Lets the agent send outbound text messages.
    // "Text +15551234567 that the deploy is done"
    //   → agent invokes sms_send tool
    //   → plugin calls Twilio API to send the message

    const SmsSendSchema = Type.Object({
      to: Type.String({
        description: "Phone number to text in E.164 format (e.g. +15551234567)",
      }),
      text: Type.String({ description: "Message text to send" }),
    });

    api.registerTool(
      {
        name: "sms_send",
        label: "Send SMS",
        description:
          "Send a text message via SMS. " +
          "Provide a phone number in E.164 format and the message text. " +
          "Keep messages concise — each SMS segment is 160 characters.",
        parameters: SmsSendSchema,
        async execute(_toolCallId: string, params: { to: string; text: string }) {
          const json = (payload: unknown) => ({
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
            details: payload,
          });

          if (!outbound) {
            return json({ error: "SMS outbound not initialized — check plugin config" });
          }

          const result = await outbound.sendSms(params.to, params.text);
          if (!result.success) {
            return json({ error: result.error });
          }
          return json({ sid: result.sid, message: `SMS sent to ${params.to}` });
        },
      },
      { names: ["sms_send"], optional: true },
    );

    // ── Gateway RPC Methods ─────────────────────────────────────────────

    api.registerGatewayMethod(
      "sms.send",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        if (!outbound) {
          respond(false, { error: "SMS outbound not initialized" });
          return;
        }
        const to = typeof params?.to === "string" ? params.to.trim() : "";
        const text = typeof params?.text === "string" ? params.text.trim() : "";
        if (!to) {
          respond(false, { error: "to required" });
          return;
        }
        if (!text) {
          respond(false, { error: "text required" });
          return;
        }
        try {
          const result = await outbound.sendSms(to, text);
          if (!result.success) {
            respond(false, { error: result.error });
            return;
          }
          respond(true, { sid: result.sid, message: `SMS sent to ${to}` });
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    api.registerGatewayMethod("sms.status", async ({ respond }: GatewayRequestHandlerOptions) => {
      respond(true, {
        running: fastify !== null,
        port: config.webhook_port,
        phoneNumber: config.phone_number || undefined,
      });
    });
  },
};

export default smsPlugin;
