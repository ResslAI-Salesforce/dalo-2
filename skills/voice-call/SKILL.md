---
name: voice-call
description: Make outbound phone calls and manage call interactions via VAPI
---

# Voice Calls

You can make and receive phone calls via VAPI.

## Inbound Calls

When someone calls in, you receive their transcribed speech as regular messages. Respond conversationally — keep responses concise since the caller is listening in real time.

- Keep it under 2-3 sentences when possible
- Avoid markdown, bullet points, code blocks — the caller hears raw text
- Use natural speech patterns ("let me check on that" instead of "processing request")
- If you need to do something that takes time, say so ("Give me a moment to look that up")

## Outbound Calls

To make an outbound call, use the script at `scripts/make-call.sh` via `exec`.

### Usage

```bash
bash <skill_dir>/scripts/make-call.sh "<phone_number>" "<first_message>"
```

Both arguments are required:

- `$1` — Phone number in E.164 format
- `$2` — The first message the recipient hears when they pick up

### Crafting the first message

The first message is what the recipient hears immediately when they answer. Always include:

1. **Who** is calling — "Hey, this is Dalo from Ressl AI"
2. **Why** — the reason for the call
3. **Context** — enough so the conversation can start naturally

Keep it conversational, 1-2 sentences max. The recipient is hearing this spoken aloud.

### When to call

- User explicitly asks you to call someone
- A task requires verbal follow-up (urgent, needs discussion, too complex for text)
- Delivering time-sensitive information

### When NOT to call

- Information can be sent via Slack/email instead
- It's outside business hours (unless urgent)
- You don't have the person's phone number

### Example

User: "Call Kush and ask if the deploy is ready"

1. Look up Kush's phone number in BUSINESS.md → +918160376548
2. Make the call with context in the first message:

```bash
bash <skill_dir>/scripts/make-call.sh "+918160376548" "Hey Kush, this is Dalo. Calling to check if the production deploy is ready to go."
```

3. Tell the user the call was placed.

## Checking Call Status

```bash
bash <skill_dir>/scripts/get-call.sh "<call_id>"
```
