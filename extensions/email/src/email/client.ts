import { OAuth2Client } from "google-auth-library";
import { google, type gmail_v1 } from "googleapis";
import { readFile } from "node:fs/promises";
import type { ParsedEmail, EmailAttachment } from "../types.js";

export type GmailClient = {
  gmail: gmail_v1.Gmail;
  auth: OAuth2Client;
  userEmail: string;
};

type StoredCredentials = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
};

type StoredToken = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
};

export async function createGmailClient(params: {
  credentialsPath: string;
  tokenPath: string;
  userEmail: string;
}): Promise<GmailClient> {
  const credRaw = await readFile(params.credentialsPath, "utf-8");
  const creds: StoredCredentials = JSON.parse(credRaw);
  const key = creds.installed ?? creds.web;
  if (!key) {
    throw new Error("Invalid credentials file: missing installed or web key");
  }

  const oAuth2Client = new OAuth2Client(key.client_id, key.client_secret, key.redirect_uris?.[0]);

  const tokenRaw = await readFile(params.tokenPath, "utf-8");
  const token: StoredToken = JSON.parse(tokenRaw);
  oAuth2Client.setCredentials(token);

  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  return { gmail, auth: oAuth2Client, userEmail: params.userEmail };
}

function extractHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!headers) {
    return "";
  }
  const lower = name.toLowerCase();
  const header = headers.find((h) => h.name?.toLowerCase() === lower);
  return header?.value?.trim() ?? "";
}

function extractAddresses(raw: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((addr) => {
      const match = addr.match(/<([^>]+)>/);
      return (match?.[1] ?? addr).trim().toLowerCase();
    })
    .filter(Boolean);
}

function extractEmailFromHeader(raw: string): string {
  if (!raw) {
    return "";
  }
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

function extractNameFromHeader(raw: string): string {
  if (!raw) {
    return "";
  }
  const match = raw.match(/^([^<]+)</);
  if (match) {
    return match[1].trim().replace(/^"(.*)"$/, "$1");
  }
  return raw.trim();
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf-8");
}

function extractBodyParts(
  parts: gmail_v1.Schema$MessagePart[] | undefined,
  result: { text: string; html: string },
): void {
  if (!parts) {
    return;
  }
  for (const part of parts) {
    const mimeType = part.mimeType?.toLowerCase() ?? "";
    if (mimeType === "text/plain" && part.body?.data && !result.text) {
      result.text = decodeBase64Url(part.body.data);
    } else if (mimeType === "text/html" && part.body?.data && !result.html) {
      result.html = decodeBase64Url(part.body.data);
    }
    if (part.parts) {
      extractBodyParts(part.parts, result);
    }
  }
}

function extractAttachments(parts: gmail_v1.Schema$MessagePart[] | undefined): EmailAttachment[] {
  if (!parts) {
    return [];
  }
  const attachments: EmailAttachment[] = [];
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      attachments.push(...extractAttachments(part.parts));
    }
  }
  return attachments;
}

export async function getMessage(client: GmailClient, messageId: string): Promise<ParsedEmail> {
  const res = await client.gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const msg = res.data;
  const headers = msg.payload?.headers;
  const fromRaw = extractHeader(headers, "From");
  const body = { text: "", html: "" };

  if (msg.payload?.body?.data) {
    const mimeType = msg.payload.mimeType?.toLowerCase() ?? "";
    const decoded = decodeBase64Url(msg.payload.body.data);
    if (mimeType === "text/html") {
      body.html = decoded;
    } else {
      body.text = decoded;
    }
  }
  extractBodyParts(msg.payload?.parts, body);

  const referencesRaw = extractHeader(headers, "References");
  const references = referencesRaw ? referencesRaw.split(/\s+/).filter(Boolean) : [];

  return {
    messageId: extractHeader(headers, "Message-ID") || msg.id || messageId,
    threadId: msg.threadId ?? "",
    from: extractEmailFromHeader(fromRaw),
    fromName: extractNameFromHeader(fromRaw) || extractEmailFromHeader(fromRaw),
    to: extractAddresses(extractHeader(headers, "To")),
    cc: extractAddresses(extractHeader(headers, "Cc")),
    subject: extractHeader(headers, "Subject"),
    bodyText: body.text,
    bodyHtml: body.html,
    inReplyTo: extractHeader(headers, "In-Reply-To"),
    references,
    date: msg.internalDate ? new Date(Number(msg.internalDate)) : null,
    attachments: extractAttachments(msg.payload?.parts),
  };
}

export async function getAttachment(
  client: GmailClient,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await client.gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  const data = res.data.data ?? "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export type SendEmailParams = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  htmlBody: string;
  textBody?: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    data: Buffer;
  }>;
};

function buildMimeMessage(from: string, params: SendEmailParams): string {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const hasAttachments = params.attachments && params.attachments.length > 0;
  const mixedBoundary = hasAttachments
    ? `----=_Mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`
    : null;

  const headers: string[] = [`From: ${from}`, `To: ${params.to.join(", ")}`];
  if (params.cc?.length) {
    headers.push(`Cc: ${params.cc.join(", ")}`);
  }
  headers.push(`Subject: ${params.subject}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push("MIME-Version: 1.0");
  if (params.inReplyTo) {
    headers.push(`In-Reply-To: ${params.inReplyTo}`);
  }
  if (params.references?.length) {
    headers.push(`References: ${params.references.join(" ")}`);
  }

  if (mixedBoundary) {
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  } else {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  }

  const lines = [...headers, ""];

  if (mixedBoundary) {
    lines.push(`--${mixedBoundary}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
  }

  if (params.textBody) {
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: quoted-printable");
    lines.push("");
    lines.push(params.textBody);
    lines.push("");
  }

  lines.push(`--${boundary}`);
  lines.push("Content-Type: text/html; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: quoted-printable");
  lines.push("");
  lines.push(params.htmlBody);
  lines.push("");
  lines.push(`--${boundary}--`);

  if (mixedBoundary && params.attachments) {
    for (const att of params.attachments) {
      lines.push(`--${mixedBoundary}`);
      lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(att.data.toString("base64"));
      lines.push("");
    }
    lines.push(`--${mixedBoundary}--`);
  }

  return lines.join("\r\n");
}

export async function sendEmail(
  client: GmailClient,
  params: SendEmailParams,
): Promise<{ messageId: string; threadId: string }> {
  const raw = buildMimeMessage(client.userEmail, params);
  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await client.gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encoded,
      threadId: params.threadId || undefined,
    },
  });

  return {
    messageId: res.data.id ?? "",
    threadId: res.data.threadId ?? "",
  };
}

export async function watchMailbox(
  client: GmailClient,
  topicName: string,
  labelIds: string[] = ["INBOX"],
): Promise<{ historyId: string; expiration: string }> {
  const res = await client.gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds,
    },
  });
  return {
    historyId: String(res.data.historyId ?? ""),
    expiration: String(res.data.expiration ?? ""),
  };
}

export async function getHistory(client: GmailClient, startHistoryId: string): Promise<string[]> {
  const res = await client.gmail.users.history.list({
    userId: "me",
    startHistoryId,
    historyTypes: ["messageAdded"],
  });

  const messageIds: string[] = [];
  for (const entry of res.data.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      if (added.message?.id) {
        messageIds.push(added.message.id);
      }
    }
  }
  return messageIds;
}
