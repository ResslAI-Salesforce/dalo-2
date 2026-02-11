---
name: email
description: Send and receive emails via Gmail
---

# Email

You can send and receive emails via Gmail.

## Inbound Emails

When someone emails the bot address, you receive the email body as a message. Each email thread maps to a conversation session — replies in the same thread continue the same context.

Tips for email responses:

- Be more thorough than chat — emails warrant longer, more complete answers
- Use proper formatting: paragraphs, headings, lists (these get converted to HTML)
- Subject lines are preserved across the thread
- CC recipients are preserved on replies when configured
- Attachments from inbound emails are available as media files

## Sending Emails

When replying to an inbound email, your response is automatically sent back to the sender (and CC recipients if `preserveCc` is enabled). Threading headers (`In-Reply-To`, `References`) are set automatically so replies appear in the same Gmail thread.

### Formatting

- Write in markdown — it gets converted to HTML for the email
- Code blocks, bold, italic, links, and lists all render properly
- A signature is appended if configured

### Attachments

- Inbound attachments are downloaded and available in context
- Outbound media files are sent as email attachments

## Important Notes

- Emails from addresses not in the allowlist are ignored (unless `dmPolicy` is "open")
- The bot skips its own outgoing emails to avoid loops
- Quoted reply text (lines starting with >) is stripped from inbound messages to extract only the new content
