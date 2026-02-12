import type { DmPolicy } from "openclaw/plugin-sdk";

export type EmailAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this email account. Default: true. */
  enabled?: boolean;
  /** Gmail address for this account (e.g. user@gmail.com). */
  gmailAddress?: string;
  /** Path to Google OAuth2 credentials JSON file. */
  credentialsPath?: string;
  /** Path to stored OAuth2 token JSON file. */
  tokenPath?: string;
  /** Google Cloud project ID (for Pub/Sub). */
  projectId?: string;
  /** Pub/Sub topic name for Gmail push notifications. */
  pubsubTopic?: string;
  /** Pub/Sub subscription name. */
  pubsubSubscription?: string;
  /** Push token for verifying Pub/Sub messages. */
  pushToken?: string;
  /** Gmail label to watch (default: INBOX). */
  watchLabel?: string;
  /** Direct message policy (pairing/allowlist/open/disabled). */
  dmPolicy?: DmPolicy;
  /** Allowlist for incoming emails (email addresses). */
  allowFrom?: string[];
  /** Preserve CC recipients on replies. Default: true. */
  preserveCc?: boolean;
  /** Email signature appended to outbound messages. */
  signature?: string;
  /** Port for the gog serve HTTP listener. */
  servePort?: number;
  /** Bind address for the gog serve HTTP listener. */
  serveBind?: string;
  /** Gmail watch renewal interval in minutes. Default: 720 (12h). */
  renewEveryMinutes?: number;
  /** Hook URL override for gog to post notifications to. */
  hookUrl?: string;
  /** Hook token for authenticating gog callbacks. */
  hookToken?: string;
  /** Polling interval in seconds when Pub/Sub is not configured. Default: 30. */
  pollIntervalSeconds?: number;
};

export type EmailConfig = {
  /** Optional per-account email configuration (multi-account). */
  accounts?: Record<string, EmailAccountConfig>;
} & EmailAccountConfig;

export type ParsedEmail = {
  messageId: string;
  threadId: string;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  inReplyTo: string;
  references: string[];
  date: Date | null;
  attachments: EmailAttachment[];
};

export type EmailAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  data?: Buffer;
};
