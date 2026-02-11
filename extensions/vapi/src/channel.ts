/**
 * VAPI voice channel plugin definition.
 *
 * Registers VAPI as a first-class message channel in OpenClaw
 * so it appears in /channels, /status, config, and the UI.
 */

import type { ChannelPlugin, ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import type { OutboundManager } from "./outbound.js";
import type { VapiAccount, VapiPluginConfig } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

const meta = {
  id: "vapi",
  label: "VAPI Voice",
  selectionLabel: "VAPI Voice (Phone)",
  detailLabel: "VAPI",
  docsPath: "/channels/vapi",
  docsLabel: "vapi",
  blurb: "Voice calls via VAPI — inbound/outbound phone calls with real-time STT/TTS.",
  aliases: ["voice", "phone", "vapi"],
  order: 200,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveVapiSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  return (cfg as Record<string, unknown>).channels
    ? (((cfg as Record<string, unknown>).channels as Record<string, unknown>)?.vapi as
        | Record<string, unknown>
        | undefined)
    : undefined;
}

function resolveAccountSection(
  cfg: OpenClawConfig,
  accountId?: string | null,
): Record<string, unknown> | undefined {
  const vapiSection = resolveVapiSection(cfg);
  if (!vapiSection) return undefined;
  const accounts = vapiSection.accounts as Record<string, Record<string, unknown>> | undefined;
  // Try account-level config first, then fall back to top-level vapi section
  return accounts?.[accountId ?? DEFAULT_ACCOUNT_ID] ?? vapiSection;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): VapiAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const section = resolveAccountSection(cfg, accountId) ?? {};

  const config: VapiPluginConfig = {
    api_key: typeof section.api_key === "string" ? section.api_key : "",
    webhook_port: typeof section.webhook_port === "number" ? section.webhook_port : 3001,
    assistant_id: typeof section.assistant_id === "string" ? section.assistant_id : undefined,
    phone_number_id:
      typeof section.phone_number_id === "string" ? section.phone_number_id : undefined,
    default_greeting:
      typeof section.default_greeting === "string" ? section.default_greeting : undefined,
    host: typeof section.host === "string" ? section.host : undefined,
  };

  const enabled = section.enabled !== false;
  const configured = Boolean(config.api_key);

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

export function createVapiChannelPlugin(deps: {
  getOutbound: () => OutboundManager | null;
}): ChannelPlugin<VapiAccount> {
  return {
    id: "vapi",
    meta,

    capabilities: {
      chatTypes: ["direct"],
      blockStreaming: true,
    },

    defaults: {
      queue: { debounceMs: 0 },
    },

    reload: { configPrefixes: ["channels.vapi"] },

    config: {
      listAccountIds: (cfg) => {
        const vapiSection = resolveVapiSection(cfg);
        if (!vapiSection) return [];
        const accounts = vapiSection.accounts as Record<string, unknown> | undefined;
        if (accounts && typeof accounts === "object") {
          return Object.keys(accounts);
        }
        // If there's a top-level api_key, treat it as "default" account
        if (typeof vapiSection.api_key === "string") {
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
        const vapiSection = resolveVapiSection(cfg);
        const hasAccountPath = Boolean(
          (vapiSection?.accounts as Record<string, unknown> | undefined)?.[resolvedId],
        );
        const basePath = hasAccountPath
          ? `channels.vapi.accounts.${resolvedId}.`
          : "channels.vapi.";
        return {
          policy: account.inboundPolicy ?? "allowlist",
          allowFrom: account.allowFrom ?? [],
          policyPath: `${basePath}inboundPolicy`,
          allowFromPath: `${basePath}allowFrom`,
          approveHint: `Add the phone number to channels.vapi.allowFrom (E.164 format, e.g. +15551234567)`,
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
            error: new Error(
              "VAPI requires a phone number in E.164 format (e.g. +15551234567). Use the vapi_call tool for outbound calls.",
            ),
          };
        }
        return { ok: true, to: cleaned };
      },

      sendText: async ({ cfg, to, text }) => {
        const outbound = deps.getOutbound();
        if (!outbound) {
          return {
            channel: "vapi" as const,
            messageId: "",
            ok: false,
            error: "VAPI outbound manager not initialized",
          };
        }
        // Voice channels send text by initiating an outbound call
        const result = await outbound.call(to, text);
        return {
          channel: "vapi" as const,
          messageId: result.callId ?? "",
          ok: result.success,
          ...(result.error ? { error: result.error } : {}),
        };
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "This is a voice channel. When sending messages via VAPI, keep text short and conversational — the recipient will hear it as speech.",
        "Avoid markdown, bullet points, and code blocks in voice messages.",
      ],
    },
  };
}
