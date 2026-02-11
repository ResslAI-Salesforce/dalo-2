/**
 * VAPI-specific types for the OpenClaw channel plugin.
 *
 * VAPI sends OpenAI-compatible /chat/completions requests.
 * We respond with OpenAI-compatible SSE chunks.
 */

// ─── Inbound request from VAPI ───────────────────────────────────────────────

export interface VapiChatRequest {
  model?: string;
  messages: VapiMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;

  /** Tool definitions attached to the assistant (OpenAI format) */
  tools?: VapiToolDefinition[];
  tool_choice?: string;

  /** Call metadata — always present on real calls */
  call?: VapiCallMetadata;

  /** Custom metadata from assistant config */
  metadata?: Record<string, unknown>;
}

export interface VapiMessage {
  role: "system" | "assistant" | "user" | "function" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface VapiCallMetadata {
  id: string;
  type?: "inboundPhoneCall" | "outboundPhoneCall";
  status?: string;
  customer?: { number?: string; name?: string };
  phoneNumber?: { number?: string };
  phoneNumberId?: string;
  createdAt?: string;
}

export interface VapiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── SSE response chunks (OpenAI format) ─────────────────────────────────────

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

// ─── Outbound call ───────────────────────────────────────────────────────────

export interface OutboundCallRequest {
  /** Phone number to call (E.164) */
  to: string;
  /** What the assistant says first when callee picks up */
  greeting?: string;
  /** Context for the agent when VAPI calls back to /chat/completions */
  context?: string;
}

export interface OutboundCallResult {
  success: boolean;
  callId?: string;
  error?: string;
}

// ─── Server events from VAPI ─────────────────────────────────────────────────

export interface VapiServerEvent {
  message: {
    type: string;
    call?: VapiCallMetadata;
    [key: string]: unknown;
  };
}

export interface EndOfCallReport {
  message: {
    type: "end-of-call-report";
    call: VapiCallMetadata;
    recordingUrl?: string;
    transcript?: string;
    summary?: string;
    endedReason?: string;
    durationSeconds?: number;
  };
}

// ─── Plugin config ───────────────────────────────────────────────────────────

export interface VapiPluginConfig {
  /** VAPI API key for outbound calls and API access */
  api_key: string;
  /** Port for the Fastify HTTP server that receives VAPI webhooks */
  webhook_port: number;
  /** VAPI assistant ID (required for outbound calls) */
  assistant_id?: string;
  /** VAPI phone number ID (required for outbound calls) */
  phone_number_id?: string;
  /** Default greeting when no user message in initial request */
  default_greeting?: string;
  /** Host to bind the server to (default: 0.0.0.0) */
  host?: string;
}

// ─── Channel account ────────────────────────────────────────────────────────

export interface VapiAccount {
  accountId: string;
  config: VapiPluginConfig;
  name?: string;
  enabled: boolean;
  configured: boolean;
  /** Phone numbers allowed to call in (E.164 format) */
  allowFrom?: string[];
  /** Inbound call policy: disabled, allowlist, pairing, open */
  inboundPolicy?: string;
}
