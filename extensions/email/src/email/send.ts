import { getEmailRuntime } from "../runtime.js";
import { resolveEmailAccount } from "./accounts.js";
import { createGmailClient, sendEmail } from "./client.js";
import { markdownToHtml, wrapInEmailTemplate } from "./html.js";

export type EmailSendOpts = {
  accountId?: string;
  subject?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string[];
  cc?: string[];
  mediaUrl?: string;
  mediaUrls?: string[];
};

export type EmailSendResult = {
  messageId: string;
  threadId: string;
  chatId: string;
};

export async function sendEmailMessage(
  to: string,
  text: string,
  opts: EmailSendOpts = {},
): Promise<EmailSendResult> {
  const core = getEmailRuntime();
  const cfg = core.config.loadConfig();
  const account = resolveEmailAccount({
    cfg,
    accountId: opts.accountId,
  });

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

  const htmlBody = markdownToHtml(text);
  const wrappedHtml = wrapInEmailTemplate(htmlBody, account.config.signature);

  // Download and attach media files
  const allMediaUrls = [
    ...(opts.mediaUrls ?? []),
    ...(opts.mediaUrl ? [opts.mediaUrl] : []),
  ].filter(Boolean);

  const attachments: Array<{ filename: string; mimeType: string; data: Buffer }> = [];
  for (const mediaUrl of allMediaUrls) {
    try {
      const media = await core.media.loadWebMedia(mediaUrl);
      attachments.push({
        filename: media.fileName ?? "attachment",
        mimeType: media.contentType ?? "application/octet-stream",
        data: media.buffer,
      });
    } catch (err) {
      core.logging
        .getChildLogger({ module: "email" })
        .debug?.(`email send: failed to load media ${mediaUrl}: ${String(err)}`);
    }
  }

  const result = await sendEmail(client, {
    to: [to],
    cc: opts.cc,
    subject: opts.subject ?? "Message",
    htmlBody: wrappedHtml,
    textBody: text,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    threadId: opts.threadId,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  core.channel.activity.record({
    channel: "email",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: result.messageId,
    threadId: result.threadId,
    chatId: to,
  };
}
