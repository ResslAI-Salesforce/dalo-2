/**
 * SMS channel plugin definition.
 *
 * Registers SMS as a first-class message channel in OpenClaw
 * so it appears in /channels, /status, config, and the UI.
 */

import type { ChannelPlugin, ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import type { OutboundManager } from "./outbound.js";
import type { SmsAccount, SmsPluginConfig } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

const meta = {
  id: "sms",
  label: "SMS",
  selectionLabel: "SMS (Text)",
  detailLabel: "SMS",
  docsPath: "/channels/sms",
  docsLabel: "sms",
  blurb: "Text messages via Twilio — inbound/outbound SMS with full agent integration.",
  aliases: ["sms", "text"],
  order: 150,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveSmsSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  return (cfg as Record<string, unknown>).channels
    ? (((cfg as Record<string, unknown>).channels as Record<string, unknown>)?.sms as
        | Record<string, unknown>
        | undefined)
    : undefined;
}

function resolveAccountSection(
  cfg: OpenClawConfig,
  accountId?: string | null,
): Record<string, unknown> | undefined {
  const smsSection = resolveSmsSection(cfg);
  if (!smsSection) return undefined;
  const accounts = smsSection.accounts as Record<string, Record<string, unknown>> | undefined;
  return accounts?.[accountId ?? DEFAULT_ACCOUNT_ID] ?? smsSection;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): SmsAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const section = resolveAccountSection(cfg, accountId) ?? {};

  const config: SmsPluginConfig = {
    account_sid: typeof section.account_sid === "string" ? section.account_sid : "",
    auth_token: typeof section.auth_token === "string" ? section.auth_token : "",
    phone_number: typeof section.phone_number === "string" ? section.phone_number : "",
    webhook_port: typeof section.webhook_port === "number" ? section.webhook_port : 3002,
    host: typeof section.host === "string" ? section.host : undefined,
  };

  const enabled = section.enabled !== false;
  const configured = Boolean(config.account_sid && config.auth_token && config.phone_number);

  return {
    accountId: id,
    config,
    name: typeof section.name === "string" ? section.name : undefined,
    enabled,
    configured,
    allowFrom: Array.isArray(section.allowFrom)
      ? (section.allowFrom as string[]).map(String)
      : undefined,
    inboundPolicy: typeof section.inboundPolicy === "string" ? section.inboundPolicy : undefined,
  };
}

// ── Channel Plugin ──────────────────────────────────────────────────────────

export function createSmsChannelPlugin(deps: {
  getOutbound: () => OutboundManager | null;
}): ChannelPlugin<SmsAccount> {
  return {
    id: "sms",
    meta,

    capabilities: {
      chatTypes: ["direct"],
      media: true,
      blockStreaming: true,
    },

    defaults: {
      queue: { debounceMs: 0 },
    },

    reload: { configPrefixes: ["channels.sms"] },

    config: {
      listAccountIds: (cfg) => {
        const smsSection = resolveSmsSection(cfg);
        if (!smsSection) return [];
        const accounts = smsSection.accounts as Record<string, unknown> | undefined;
        if (accounts && typeof accounts === "object") {
          return Object.keys(accounts);
        }
        // If there's a top-level account_sid, treat it as "default" account
        if (typeof smsSection.account_sid === "string") {
          return [DEFAULT_ACCOUNT_ID];
        }
        return [];
      },

      resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),

      defaultAccountId: () => DEFAULT_ACCOUNT_ID,

      isConfigured: (account) => account.configured,

      isEnabled: (account) => account.enabled,

      describeAccount: (account): ChannelAccountSnapshot => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        port: account.config.webhook_port,
      }),

      resolveAllowFrom: ({ cfg, accountId }) => {
        const account = resolveAccount(cfg, accountId);
        return account.allowFrom;
      },
    },

    security: {
      resolveDmPolicy: ({ cfg, accountId, account }) => {
        const resolvedId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
        const smsSection = resolveSmsSection(cfg);
        const hasAccountPath = Boolean(
          (smsSection?.accounts as Record<string, unknown> | undefined)?.[resolvedId],
        );
        const basePath = hasAccountPath ? `channels.sms.accounts.${resolvedId}.` : "channels.sms.";
        return {
          policy: account.inboundPolicy ?? "allowlist",
          allowFrom: account.allowFrom ?? [],
          policyPath: `${basePath}inboundPolicy`,
          allowFromPath: `${basePath}allowFrom`,
          approveHint: `Add the phone number to channels.sms.allowFrom (E.164 format, e.g. +15551234567)`,
          normalizeEntry: (raw: string) => raw.replace(/[^+0-9]/g, ""),
        };
      },
    },

    messaging: {
      normalizeTarget: (raw) => {
        const cleaned = raw.replace(/[^+0-9]/g, "");
        return cleaned.startsWith("+") ? cleaned : undefined;
      },
      targetResolver: {
        looksLikeId: (raw) => /^\+[1-9]\d{1,14}$/.test(raw.trim()),
        hint: "<phone number in E.164 format, e.g. +15551234567>",
      },
    },

    outbound: {
      deliveryMode: "direct",

      resolveTarget: ({ to }) => {
        const cleaned = to?.replace(/[^+0-9]/g, "");
        if (!cleaned || !cleaned.startsWith("+")) {
          return {
            ok: false,
            error: new Error("SMS requires a phone number in E.164 format (e.g. +15551234567)."),
          };
        }
        return { ok: true, to: cleaned };
      },

      sendText: async ({ cfg, to, text }) => {
        const outbound = deps.getOutbound();
        if (!outbound) {
          return {
            channel: "sms" as const,
            messageId: "",
            ok: false,
            error: "SMS outbound manager not initialized",
          };
        }
        const result = await outbound.sendSms(to, text);
        return {
          channel: "sms" as const,
          messageId: result.sid ?? "",
          ok: result.success,
          ...(result.error ? { error: result.error } : {}),
        };
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "This is an SMS channel. Keep messages concise — each SMS segment is 160 characters (GSM-7) or 70 characters (Unicode).",
        "Use plain text only. Avoid markdown, code blocks, bullet points, and long formatting — recipients see raw text on their phone.",
      ],
    },
  };
}
