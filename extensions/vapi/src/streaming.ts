/**
 * SSE streaming helpers for VAPI's OpenAI-compatible protocol.
 *
 * VAPI expects responses in the exact format of OpenAI's /chat/completions
 * streaming API. Each chunk is a Server-Sent Event with a JSON payload.
 * VAPI pipes text chunks directly to TTS as they arrive, so the caller
 * hears speech progressively without waiting for the full response.
 */

import type { ServerResponse } from "node:http";
import type { ChatCompletionChunk } from "./types.js";

/**
 * Start an SSE stream on a raw HTTP response.
 */
export function startStream(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

/**
 * Write a text chunk to the SSE stream.
 * VAPI sends this immediately to TTS — caller hears it in real time.
 */
export function writeChunk(res: ServerResponse, callId: string, text: string): void {
  const chunk: ChatCompletionChunk = {
    id: `chatcmpl-${callId}`,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

/**
 * End the SSE stream with a stop signal.
 * Sends finish_reason: "stop" then [DONE], matching OpenAI's protocol.
 */
export function endStream(res: ServerResponse, callId: string): void {
  const stop: ChatCompletionChunk = {
    id: `chatcmpl-${callId}`,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  res.write(`data: ${JSON.stringify(stop)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Send a complete single-shot message as SSE (greeting, error, etc.)
 * and close the stream.
 */
export function sendAndClose(res: ServerResponse, callId: string, text: string): void {
  startStream(res);
  writeChunk(res, callId, text);
  endStream(res, callId);
}
