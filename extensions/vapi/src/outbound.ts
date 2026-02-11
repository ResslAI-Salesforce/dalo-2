/**
 * Outbound call management via VAPI API.
 *
 * Makes outbound phone calls by hitting VAPI's REST API.
 * When VAPI connects the call, it calls back to /chat/completions
 * with call.type = "outboundPhoneCall". We store context per callId
 * so the agent knows why it's calling when the callback arrives.
 */

import type { VapiPluginConfig, OutboundCallResult } from "./types.js";

/** Stored context for outbound calls, keyed by VAPI call ID */
export interface OutboundContext {
  context: string;
  calleeName?: string;
  calleeNumber: string;
  initiatedAt: string;
}

export class OutboundManager {
  private config: VapiPluginConfig;
  private contexts = new Map<string, OutboundContext>();
  private logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  constructor(
    config: VapiPluginConfig,
    logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  ) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Make an outbound call via VAPI's API.
   *
   * Flow:
   * 1. POST to https://api.vapi.ai/call/phone with assistant + phone number
   * 2. VAPI dials the number and plays firstMessage (greeting)
   * 3. When callee speaks, VAPI calls our /chat/completions with call.type = "outboundPhoneCall"
   * 4. We retrieve stored context and inject it into the agent session
   */
  async call(to: string, greeting?: string, context?: string): Promise<OutboundCallResult> {
    const { api_key, assistant_id, phone_number_id } = this.config;

    if (!assistant_id || !phone_number_id) {
      return {
        success: false,
        error: "assistant_id and phone_number_id required for outbound calls",
      };
    }

    const cleanNumber = to.replace(/[^+0-9]/g, "");

    const body: Record<string, unknown> = {
      assistantId: assistant_id,
      phoneNumberId: phone_number_id,
      customer: { number: cleanNumber },
    };

    if (greeting) {
      body.firstMessage = greeting;
    }

    try {
      const response = await fetch("https://api.vapi.ai/call/phone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `VAPI API ${response.status}: ${errorText}` };
      }

      const data = (await response.json()) as { id: string };
      const callId = data.id;

      // Store context for retrieval when VAPI calls back to /chat/completions
      if (context) {
        this.contexts.set(callId, {
          context,
          calleeNumber: cleanNumber,
          initiatedAt: new Date().toISOString(),
        });
      }

      this.logger.info(`Outbound call initiated: ${callId} → ${cleanNumber}`);
      return { success: true, callId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Outbound call failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Retrieve and consume stored context for an outbound call.
   * Called when VAPI hits /chat/completions for an outbound call.
   */
  consumeContext(callId: string): OutboundContext | undefined {
    const ctx = this.contexts.get(callId);
    if (ctx) {
      this.contexts.delete(callId);
    }
    return ctx;
  }

  /**
   * Check if a call ID has stored outbound context.
   */
  hasContext(callId: string): boolean {
    return this.contexts.has(callId);
  }
}
