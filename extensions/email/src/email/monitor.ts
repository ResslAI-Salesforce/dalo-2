import type { ChildProcess } from "node:child_process";
import type {
  ChannelAccountSnapshot,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import { execFileSync, spawn } from "node:child_process";
import { createReplyPrefixOptions, resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk";
import { getEmailRuntime } from "../runtime.js";
import { resolveEmailAccount } from "./accounts.js";
import { createGmailClient, getAttachment, getMessage, type GmailClient } from "./client.js";
import { htmlToPlainText } from "./html.js";
import { sendEmailMessage } from "./send.js";
import { buildEmailSessionKey, extractLatestContent, resolveReplyRecipients } from "./threading.js";

export type MonitorEmailOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

const RECENT_MESSAGE_TTL_MS = 10 * 60_000;
const RECENT_MESSAGE_MAX = 2000;
const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;
const DEFAULT_GMAIL_SERVE_PORT = 8790;
const DEFAULT_GMAIL_SERVE_BIND = "127.0.0.1";
const DEFAULT_RENEW_MINUTES = 12 * 60;

type DedupeCache = {
  check: (key: string | undefined | null, now?: number) => boolean;
};

function createDedupeCache(options: { ttlMs: number; maxSize: number }): DedupeCache {
  const ttlMs = Math.max(0, options.ttlMs);
  const maxSize = Math.max(0, Math.floor(options.maxSize));
  const cache = new Map<string, number>();

  const touch = (key: string, now: number) => {
    cache.delete(key);
    cache.set(key, now);
  };

  const prune = (now: number) => {
    const cutoff = ttlMs > 0 ? now - ttlMs : undefined;
    if (cutoff !== undefined) {
      for (const [entryKey, entryTs] of cache) {
        if (entryTs < cutoff) {
          cache.delete(entryKey);
        }
      }
    }
    while (cache.size > maxSize) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  };

  return {
    check: (key, now = Date.now()) => {
      if (!key) {
        return false;
      }
      const existing = cache.get(key);
      if (existing !== undefined && (ttlMs <= 0 || now - existing < ttlMs)) {
        touch(key, now);
        return true;
      }
      touch(key, now);
      prune(now);
      return false;
    },
  };
}

const recentInboundMessages = createDedupeCache({
  ttlMs: RECENT_MESSAGE_TTL_MS,
  maxSize: RECENT_MESSAGE_MAX,
});

type MediaInfo = {
  path: string;
  contentType?: string;
};

function buildMediaPayload(mediaList: MediaInfo[]): Record<string, unknown> {
  if (mediaList.length === 0) {
    return {};
  }
  const first = mediaList[0];
  const mediaPaths = mediaList.map((m) => m.path);
  const mediaTypes = mediaList.map((m) => m.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}

type EmailInboundPayload = {
  messageId?: string;
  historyId?: string;
  emailAddress?: string;
};

export type EmailInboundHandler = (
  req: { body: unknown; headers: Record<string, string | undefined> },
  res: { status: (code: number) => { json: (data: unknown) => void; end: () => void } },
) => Promise<void>;

export function createEmailInboundHandler(opts: {
  getClient: (accountId: string) => Promise<GmailClient | null>;
  accountId: string;
}): EmailInboundHandler {
  return async (req, res) => {
    const core = getEmailRuntime();
    const logger = core.logging.getChildLogger({ module: "email" });

    try {
      const payload = req.body as EmailInboundPayload;
      const messageId = payload?.messageId;
      if (!messageId) {
        res.status(200).json({ ok: true, skipped: "no messageId" });
        return;
      }

      if (recentInboundMessages.check(`${opts.accountId}:${messageId}`)) {
        res.status(200).json({ ok: true, skipped: "duplicate" });
        return;
      }

      const client = await opts.getClient(opts.accountId);
      if (!client) {
        res.status(500).json({ error: "Gmail client not available" });
        return;
      }

      await processInboundEmail({ client, messageId, accountId: opts.accountId, logger });
      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error?.(`email inbound error: ${String(err)}`);
      res.status(500).json({ error: String(err) });
    }
  };
}

async function processInboundEmail(params: {
  client: GmailClient;
  messageId: string;
  accountId: string;
  logger: { debug?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<void> {
  const { client, messageId, accountId, logger } = params;
  const core = getEmailRuntime();
  const cfg = core.config.loadConfig();
  const account = resolveEmailAccount({ cfg, accountId });
  const botEmail = account.gmailAddress?.toLowerCase() ?? client.userEmail.toLowerCase();

  const email = await getMessage(client, messageId);

  // Skip emails from self
  if (email.from.toLowerCase() === botEmail) {
    return;
  }

  // Check allowlist
  const dmPolicy = account.config.dmPolicy ?? "allowlist";
  const allowFrom = (account.config.allowFrom ?? []).map((e) => e.toLowerCase());
  if (dmPolicy === "disabled") {
    return;
  }
  if (dmPolicy !== "open" && allowFrom.length > 0 && !allowFrom.includes("*")) {
    if (!allowFrom.includes(email.from.toLowerCase())) {
      logger.debug?.(`email: dropping message from ${email.from} (not in allowFrom)`);
      return;
    }
  }

  // Extract body text
  let bodyText = email.bodyText;
  if (!bodyText && email.bodyHtml) {
    bodyText = htmlToPlainText(email.bodyHtml);
  }
  const latestContent = extractLatestContent(bodyText);
  if (!latestContent && email.attachments.length === 0) {
    return;
  }

  // Download attachments
  const mediaMaxBytes =
    resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => undefined,
      accountId,
    }) ?? 8 * 1024 * 1024;
  const mediaList: MediaInfo[] = [];
  for (const att of email.attachments) {
    try {
      const data = await getAttachment(client, messageId, att.attachmentId);
      const saved = await core.channel.media.saveMediaBuffer(
        data,
        att.mimeType,
        "inbound",
        mediaMaxBytes,
      );
      mediaList.push({
        path: saved.path,
        contentType: saved.contentType ?? att.mimeType,
      });
    } catch (err) {
      logger.debug?.(`email: failed to download attachment ${att.filename}: ${String(err)}`);
    }
  }

  const sessionKey = buildEmailSessionKey(accountId, email.threadId);
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "email",
    accountId,
    peer: {
      kind: "direct",
      id: email.from,
    },
  });

  core.channel.activity.record({
    channel: "email",
    accountId,
    direction: "inbound",
  });

  const mediaPlaceholder =
    mediaList.length > 0
      ? `\n<media:document> (${mediaList.length} attachment${mediaList.length > 1 ? "s" : ""})`
      : "";
  const subjectLine = email.subject ? `Subject: ${email.subject}` : "";
  const fromLine = `From: ${email.fromName} <${email.from}>`;
  const bodyForEnvelope = [subjectLine, fromLine, "", latestContent + mediaPlaceholder]
    .filter((line) => line !== undefined)
    .join("\n")
    .trim();

  const body = core.channel.reply.formatInboundEnvelope({
    channel: "Email",
    from: `${email.fromName} <${email.from}>`,
    body: bodyForEnvelope,
    chatType: "direct",
    sender: { name: email.fromName, id: email.from },
  });

  const mediaPayload = buildMediaPayload(mediaList);

  const preserveCc = account.config.preserveCc !== false;
  const replyRecipients = resolveReplyRecipients({
    botEmail,
    originalFrom: email.from,
    originalTo: email.to,
    originalCc: email.cc,
    preserveCc,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: latestContent || bodyText,
    RawBody: bodyText,
    CommandBody: latestContent || bodyText,
    From: `email:${email.from}`,
    To: email.from,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: `${email.fromName} <${email.from}>`,
    SenderName: email.fromName,
    SenderId: email.from,
    Provider: "email" as const,
    Surface: "email" as const,
    MessageSid: messageId,
    MessageThreadId: email.threadId,
    OriginatingChannel: "email" as const,
    OriginatingTo: email.from,
    EmailSubject: email.subject,
    EmailCc: email.cc.join(", "),
    EmailInReplyTo: email.inReplyTo,
    EmailReferences: email.references.join(" "),
    EmailReplyTo: JSON.stringify(replyRecipients.to),
    EmailReplyCc: JSON.stringify(replyRecipients.cc),
    ...mediaPayload,
  });

  // Update last route for session
  const sessionCfg = cfg.session;
  const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
    agentId: route.agentId,
  });
  await core.channel.session.updateLastRoute({
    storePath,
    sessionKey: route.mainSessionKey,
    deliveryContext: {
      channel: "email",
      to: email.from,
      accountId: route.accountId,
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "email",
    accountId,
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        await sendEmailMessage(email.from, text, {
          accountId,
          threadId: email.threadId,
          subject: email.subject ? `Re: ${email.subject.replace(/^Re:\s*/i, "")}` : "Re:",
          inReplyTo: email.messageId,
          references: [...email.references, email.messageId],
          cc: replyRecipients.cc,
          mediaUrls,
        });
      },
      onError: (err, info) => {
        logger.error?.(`email ${info.kind} reply failed: ${String(err)}`);
      },
    });

  await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected,
    },
  });
  markDispatchIdle();
}

export async function monitorEmailProvider(opts: MonitorEmailOpts = {}): Promise<void> {
  const core = getEmailRuntime();
  const cfg = opts.config ?? core.config.loadConfig();
  const account = resolveEmailAccount({
    cfg,
    accountId: opts.accountId,
  });
  const logger = core.logging.getChildLogger({ module: "email" });

  if (!account.gmailAddress) {
    throw new Error(
      `Email gmailAddress missing for account "${account.accountId}" (set channels.email.gmailAddress).`,
    );
  }
  if (!account.credentialsPath) {
    throw new Error(
      `Email credentialsPath missing for account "${account.accountId}" (set channels.email.credentialsPath).`,
    );
  }
  if (!account.tokenPath) {
    throw new Error(
      `Email tokenPath missing for account "${account.accountId}" (set channels.email.tokenPath).`,
    );
  }

  const client = await createGmailClient({
    credentialsPath: account.credentialsPath,
    tokenPath: account.tokenPath,
    userEmail: account.gmailAddress,
  });

  logger.debug?.(`email: connected as ${account.gmailAddress}`);
  opts.statusSink?.({
    running: true,
    connected: true,
    lastConnectedAt: Date.now(),
    lastStartAt: Date.now(),
  });

  // Register the inbound handler for HTTP route callbacks
  emailClients.set(account.accountId, client);

  // Try to start gog gmail watch if available
  const servePort = account.config.servePort ?? DEFAULT_GMAIL_SERVE_PORT;
  const serveBind = account.config.serveBind ?? DEFAULT_GMAIL_SERVE_BIND;
  const renewMinutes = account.config.renewEveryMinutes ?? DEFAULT_RENEW_MINUTES;
  const hookToken = account.config.hookToken ?? "";
  const pushToken = account.config.pushToken ?? "";
  const topic = account.config.pubsubTopic ?? "";

  if (topic && pushToken) {
    // Build gog args for spawning gmail watch serve
    const gatewayPort =
      (typeof (cfg as Record<string, unknown>).gateway === "object" &&
        (cfg as { gateway?: { port?: number } }).gateway?.port) ||
      18789;
    const hookUrl = account.config.hookUrl ?? `http://127.0.0.1:${gatewayPort}/email/inbound`;

    const serveArgs = [
      "gmail",
      "watch",
      "serve",
      "--account",
      account.gmailAddress,
      "--bind",
      serveBind,
      "--port",
      String(servePort),
      "--path",
      "/gmail-pubsub",
      "--token",
      pushToken,
      "--hook-url",
      hookUrl,
      ...(hookToken ? ["--hook-token", hookToken] : []),
      "--include-body",
    ];

    const startArgs = [
      "gmail",
      "watch",
      "start",
      "--account",
      account.gmailAddress,
      "--label",
      account.config.watchLabel ?? "INBOX",
      "--topic",
      topic,
    ];

    let watcherProcess: ChildProcess | null = null;
    let renewInterval: ReturnType<typeof setInterval> | null = null;
    let shuttingDown = false;

    const spawnServe = (): ChildProcess => {
      let addressInUse = false;
      const child = spawn("gog", serveArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      child.stdout?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          logger.debug?.(`[gog] ${line}`);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (!line) {
          return;
        }
        if (ADDRESS_IN_USE_RE.test(line)) {
          addressInUse = true;
        }
        logger.debug?.(`[gog] ${line}`);
      });

      child.on("error", (err) => {
        logger.error?.(`gog process error: ${String(err)}`);
      });

      child.on("exit", (code, signal) => {
        if (shuttingDown) {
          return;
        }
        if (addressInUse) {
          logger.debug?.("gog serve failed to bind (address already in use); stopping restarts.");
          watcherProcess = null;
          return;
        }
        logger.debug?.(`gog exited (code=${code}, signal=${signal}); restarting in 5s`);
        watcherProcess = null;
        setTimeout(() => {
          if (shuttingDown) {
            return;
          }
          watcherProcess = spawnServe();
        }, 5000);
      });

      return child;
    };

    // Start watch registration
    try {
      execFileSync("gog", startArgs, { timeout: 120_000, stdio: "pipe" });
      logger.debug?.(`email: watch started for ${account.gmailAddress}`);
    } catch (err) {
      logger.debug?.(`email: watch start failed (continuing): ${String(err)}`);
    }

    watcherProcess = spawnServe();

    // Renewal interval
    renewInterval = setInterval(() => {
      if (shuttingDown) {
        return;
      }
      try {
        execFileSync("gog", startArgs, { timeout: 120_000, stdio: "pipe" });
      } catch {
        // Renewal failure is non-fatal
      }
    }, renewMinutes * 60_000);

    // Cleanup on abort
    opts.abortSignal?.addEventListener("abort", () => {
      shuttingDown = true;
      if (renewInterval) {
        clearInterval(renewInterval);
      }
      if (watcherProcess) {
        watcherProcess.kill("SIGTERM");
      }
      emailClients.delete(account.accountId);
      opts.statusSink?.({
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    });
  }
}

// Shared client store so the HTTP handler can look up clients by accountId
const emailClients = new Map<string, GmailClient>();

export function getEmailClient(accountId: string): GmailClient | null {
  return emailClients.get(accountId) ?? null;
}
