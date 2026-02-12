#!/usr/bin/env node
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
/**
 * Quick test: send an email via Gmail API using the configured credentials.
 * Usage: node extensions/email/scripts/test-send.mjs <to-address> [subject] [body]
 */
import { readFileSync } from "node:fs";

const TO = process.argv[2];
if (!TO) {
  console.error("Usage: node test-send.mjs <to-address> [subject] [body]");
  process.exit(1);
}

const SUBJECT = process.argv[3] || "Test from Dalo Email Channel";
const BODY =
  process.argv[4] || "Hello! This is a test email sent via the Dalo email channel plugin.";
const FROM = "dalo@ressl.ai";

const creds = JSON.parse(
  readFileSync(process.env.HOME + "/.config/gogcli/credentials.json", "utf-8"),
);
const key = creds.web || creds.installed;
const token = JSON.parse(readFileSync(process.env.HOME + "/.config/gogcli/token.json", "utf-8"));

const client = new OAuth2Client(key.client_id, key.client_secret, key.redirect_uris?.[0]);
client.setCredentials(token);

const gmail = google.gmail({ version: "v1", auth: client });

// Build RFC 2822 message
const message = [
  `From: ${FROM}`,
  `To: ${TO}`,
  `Subject: ${SUBJECT}`,
  `Content-Type: text/html; charset=utf-8`,
  "",
  `<html><body><p>${BODY}</p></body></html>`,
].join("\r\n");

const raw = Buffer.from(message).toString("base64url");

try {
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  console.log("Email sent!");
  console.log("Message ID:", res.data.id);
  console.log("Thread ID:", res.data.threadId);
} catch (err) {
  console.error("Send failed:", err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
}
