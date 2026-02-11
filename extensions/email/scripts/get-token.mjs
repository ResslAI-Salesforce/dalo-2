#!/usr/bin/env node
import { OAuth2Client } from "google-auth-library";
import { exec } from "node:child_process";
/**
 * One-time OAuth2 token generation for Gmail API.
 * Run: node extensions/email/scripts/get-token.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";

const CREDS_PATH = process.env.CREDS_PATH || `${process.env.HOME}/.config/gogcli/credentials.json`;
const TOKEN_PATH = process.env.TOKEN_PATH || `${process.env.HOME}/.config/gogcli/token.json`;
const SCOPES = ["https://mail.google.com/", "https://www.googleapis.com/auth/pubsub"];
const PORT = 8976;

const raw = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
const key = raw.installed ?? raw.web;
if (!key) {
  console.error("Invalid credentials.json — missing 'installed' or 'web' key");
  process.exit(1);
}

const redirectUri = `http://localhost:${PORT}/callback`;
const client = new OAuth2Client(key.client_id, key.client_secret, redirectUri);

const authUrl = client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

console.log(`\nOpening browser for OAuth2 consent...\n`);
console.log(`If it doesn't open, visit:\n${authUrl}\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Missing code parameter");
    return;
  }

  try {
    const { tokens } = await client.getToken(code);
    mkdirSync(`${process.env.HOME}/.config/gogcli`, { recursive: true });
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log(`Token saved to ${TOKEN_PATH}`);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Success!</h1><p>Token saved. You can close this tab.</p>");
  } catch (err) {
    console.error("Token exchange failed:", err.message);
    res.writeHead(500);
    res.end(`Token exchange failed: ${err.message}`);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  exec(`open "${authUrl}"`);
});
