import { convert } from "html-to-text";

export function htmlToPlainText(html: string): string {
  if (!html) {
    return "";
  }
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  }).trim();
}

export function markdownToHtml(markdown: string): string {
  if (!markdown) {
    return "";
  }
  let html = markdown;

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    return `<pre style="background:#f6f8fa;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px"><code>${escaped}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, (_match, code) => {
    return `<code style="background:#f0f0f0;padding:2px 4px;border-radius:3px;font-size:13px">${escapeHtml(code)}</code>`;
  });

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#0366d6">$1</a>');

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3 style="margin:16px 0 8px">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="margin:16px 0 8px">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="margin:16px 0 8px">$1</h1>');

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Horizontal rules
  html = html.replace(/^---+$/gm, "<hr>");

  // Paragraphs: replace double newlines with paragraph breaks
  html = html.replace(/\n\n+/g, "</p><p>");
  html = `<p>${html}</p>`;

  // Single newlines to <br>
  html = html.replace(/\n/g, "<br>");

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, "");

  return html;
}

export function wrapInEmailTemplate(body: string, signature?: string): string {
  const sigBlock = signature
    ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e0e0e0;color:#666;font-size:12px">${escapeHtml(signature)}</div>`
    : "";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;color:#24292e;line-height:1.5;max-width:600px">
${body}
${sigBlock}
</body>
</html>`;
}

export function stripEmailQuotes(text: string): string {
  if (!text) {
    return "";
  }
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    // Stop at common quote markers
    if (/^On .+ wrote:$/i.test(line.trim())) {
      break;
    }
    if (/^-{2,}\s*Original Message/i.test(line.trim())) {
      break;
    }
    if (/^_{2,}$/.test(line.trim())) {
      break;
    }
    // Skip quoted lines
    if (line.startsWith(">")) {
      continue;
    }
    result.push(line);
  }
  return result.join("\n").trim();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
