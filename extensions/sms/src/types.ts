/**
 * SMS-specific types for the OpenClaw channel plugin.
 *
 * Twilio sends inbound SMS as form-urlencoded POST requests.
 * We send outbound SMS via Twilio's REST API.
 */

// ─── Inbound webhook payload from Twilio ────────────────────────────────────

export interface TwilioInboundPayload {
  /** Unique identifier for this message */
  MessageSid: string;
  /** Twilio account SID */
  AccountSid: string;
  /** Sender phone number (E.164) */
  From: string;
  /** Recipient phone number (E.164) — your Twilio number */
  To: string;
  /** Message text body */
  Body: string;
  /** Number of media attachments */
  NumMedia: string;
  /** Media URLs (MediaUrl0, MediaUrl1, etc.) */
  [key: `MediaUrl${number}`]: string;
  /** Media content types (MediaContentType0, etc.) */
  [key: `MediaContentType${number}`]: string;
  /** SMS status */
  SmsStatus?: string;
  /** Number of SMS segments */
  NumSegments?: string;
}

// ─── Outbound SMS result ────────────────────────────────────────────────────

export interface SmsOutboundResult {
  success: boolean;
  /** Twilio message SID */
  sid?: string;
  error?: string;
}

// ─── Plugin config ──────────────────────────────────────────────────────────

export interface SmsPluginConfig {
  /** Twilio Account SID */
  account_sid: string;
  /** Twilio Auth Token */
  auth_token: string;
  /** Twilio phone number (E.164) — used as From number */
  phone_number: string;
  /** Port for the Fastify HTTP server that receives Twilio webhooks */
  webhook_port: number;
  /** Host to bind the server to (default: 0.0.0.0) */
  host?: string;
}

// ─── Channel account ────────────────────────────────────────────────────────

export interface SmsAccount {
  accountId: string;
  config: SmsPluginConfig;
  name?: string;
  enabled: boolean;
  configured: boolean;
  /** Phone numbers allowed to send inbound SMS (E.164 format) */
  allowFrom?: string[];
  /** Inbound SMS policy: disabled, allowlist, pairing, open */
  inboundPolicy?: string;
}
