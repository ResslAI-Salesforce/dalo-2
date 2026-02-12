import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { EmailConfigSchema } from "./config-schema.js";
import {
  listEmailAccountIds,
  resolveDefaultEmailAccountId,
  resolveEmailAccount,
  type ResolvedEmailAccount,
} from "./email/accounts.js";
import { monitorEmailProvider } from "./email/monitor.js";
import { sendEmailMessage } from "./email/send.js";
import { getEmailRuntime } from "./runtime.js";

const meta = {
  id: "email",
  label: "Email (Gmail)",
  selectionLabel: "Email (Gmail plugin)",
  detailLabel: "Email (Gmail)",
  docsPath: "/channels/email",
  docsLabel: "email",
  blurb: "Gmail-based email channel; install the plugin to enable.",
  systemImage: "envelope",
  order: 70,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^email:/i, "")
    .toLowerCase();
}

function formatAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^email:/i, "").toLowerCase();
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailPlugin: ChannelPlugin<ResolvedEmailAccount> = {
  id: "email",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct"],
    threads: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.email"] },
  configSchema: buildChannelConfigSchema(EmailConfigSchema),
  config: {
    listAccountIds: (cfg) => listEmailAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveEmailAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultEmailAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "email",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "email",
        accountId,
        clearBaseFields: ["gmailAddress", "credentialsPath", "tokenPath", "name"],
      }),
    isConfigured: (account) =>
      Boolean(account.gmailAddress && account.credentialsPath && account.tokenPath),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.gmailAddress && account.credentialsPath && account.tokenPath),
      gmailAddress: account.gmailAddress,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveEmailAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => formatAllowEntry(String(entry))).filter(Boolean),
  },
  pairing: {
    idLabel: "emailAddress",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.email?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.email.accounts.${resolvedAccountId}.`
        : "channels.email.";
      return {
        policy: account.config.dmPolicy ?? "allowlist",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("email"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
  },
  messaging: {
    normalizeTarget: (raw) => raw.trim().toLowerCase(),
    targetResolver: {
      looksLikeId: (raw) => EMAIL_REGEX.test(raw.trim()),
      hint: "<email-address>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 50000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Email requires --to <email-address>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId }) => {
      const result = await sendEmailMessage(to, text, {
        accountId: accountId ?? undefined,
        subject: "Message",
      });
      return { channel: "email", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const result = await sendEmailMessage(to, text, {
        accountId: accountId ?? undefined,
        subject: "Message",
        mediaUrl,
      });
      return { channel: "email", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      gmailAddress: snapshot.gmailAddress ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.gmailAddress && account.credentialsPath),
      gmailAddress: account.gmailAddress,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "email",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      const gmailAddress = input.gmailAddress ?? input.email;
      const credentialsPath = input.credentialsPath;
      if (!gmailAddress) {
        return "Email requires a Gmail address (--gmail-address).";
      }
      if (!credentialsPath) {
        return "Email requires a credentials path (--credentials-path).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const gmailAddress = input.gmailAddress ?? input.email;
      const credentialsPath = input.credentialsPath;
      const tokenPath = input.tokenPath;
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "email",
        accountId,
        name: input.name,
      });
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            email: {
              ...namedConfig.channels?.email,
              enabled: true,
              ...(gmailAddress ? { gmailAddress } : {}),
              ...(credentialsPath ? { credentialsPath } : {}),
              ...(tokenPath ? { tokenPath } : {}),
            },
          },
        };
      }
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          email: {
            ...namedConfig.channels?.email,
            enabled: true,
            accounts: {
              ...namedConfig.channels?.email?.accounts,
              [accountId]: {
                ...namedConfig.channels?.email?.accounts?.[accountId],
                enabled: true,
                ...(gmailAddress ? { gmailAddress } : {}),
                ...(credentialsPath ? { credentialsPath } : {}),
                ...(tokenPath ? { tokenPath } : {}),
              },
            },
          },
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        gmailAddress: account.gmailAddress,
      });
      ctx.log?.info(`[${account.accountId}] starting email channel`);
      return monitorEmailProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
