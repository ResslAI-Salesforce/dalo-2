---
name: sms
description: Send outbound text messages and understand inbound SMS interactions
tools:
  - sms_send
---

# SMS

You can send and receive text messages via SMS (Twilio).

## Inbound Messages

When someone texts in, you receive their message as a regular message. Respond concisely — SMS has character limits and recipients read on small screens.

Tips for SMS responses:

- Keep it under 160 characters per segment when possible (Twilio handles concatenation for longer messages)
- Use plain text only — no markdown, bullet points, or code blocks
- Be direct and actionable — people expect quick, clear texts
- If you need to send a lot of information, break it into multiple focused messages

## Outbound Messages

Use the `sms_send` tool to text someone. You need:

- **to** (required): Phone number in E.164 format (e.g., +15551234567)
- **text** (required): The message to send

### When to text

- User explicitly asks you to text someone
- Delivering notifications or alerts
- Quick confirmations or status updates
- Time-sensitive information that needs immediate attention

### When NOT to text

- Long-form content (use email instead)
- Sensitive information (phone numbers are not encrypted end-to-end)
- You don't have the person's phone number
- The information isn't urgent and can go through other channels

### Example

User: "Text Sarah that the deploy is done"

1. Look up Sarah's phone number in the directory
2. Send the message:

```
sms_send({
  to: "+15551234567",
  text: "Hey Sarah, the production deploy just finished successfully."
})
```

### Character Limits

- GSM-7 (standard ASCII): 160 characters per segment
- UCS-2 (Unicode/emoji): 70 characters per segment
- Twilio automatically concatenates long messages into multiple segments
- Each segment is billed separately, so keep messages concise when possible
