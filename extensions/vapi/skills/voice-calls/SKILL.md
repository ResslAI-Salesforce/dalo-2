---
name: voice-calls
description: Make outbound phone calls and understand inbound voice interactions
tools:
  - vapi_call
---

# Voice Calls

You can make and receive phone calls via VAPI.

## Inbound Calls

When someone calls in, you receive their transcribed speech as regular messages. Respond conversationally — keep responses concise since the caller is listening in real time. Long responses cause awkward pauses.

Tips for voice responses:

- Keep it under 2-3 sentences when possible
- Avoid markdown, bullet points, code blocks — the caller hears raw text
- Use natural speech patterns ("let me check on that" instead of "processing request")
- If you need to do something that takes time, say so ("Give me a moment to look that up")

## Outbound Calls

Use the `vapi_call` tool to call someone. You need:

- **to** (required): Phone number in E.164 format (e.g., +15551234567)
- **greeting** (optional): What to say when they pick up. If omitted, the default assistant greeting plays.
- **context** (optional): Why you're calling. This gets injected back into your context when the callee responds, so you remember the purpose.

### When to call

- User explicitly asks you to call someone
- A task requires verbal follow-up (urgent, needs discussion, too complex for text)
- Delivering time-sensitive information

### When NOT to call

- Information can be sent via Slack/email instead
- It's outside business hours (unless urgent)
- You don't have the person's phone number

### Example

User: "Call Sarah and ask if the deploy is ready"

1. Look up Sarah's phone number in the directory
2. Call with context so you remember why:

```
vapi_call({
  to: "+15551234567",
  greeting: "Hi Sarah, this is your AI assistant calling about the deploy.",
  context: "Ask Sarah if the production deploy is ready to go. Report back to the user."
})
```

3. When Sarah picks up and responds, you'll see your context and can have the conversation.
4. After the call, relay the result back to the user on their original channel.
