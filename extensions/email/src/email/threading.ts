export function buildEmailSessionKey(accountId: string, threadId: string): string {
  return `email:${accountId}:thread:${threadId}`;
}

export type ReplyRecipients = {
  to: string[];
  cc: string[];
};

export function resolveReplyRecipients(params: {
  botEmail: string;
  originalFrom: string;
  originalTo: string[];
  originalCc: string[];
  preserveCc: boolean;
}): ReplyRecipients {
  const { botEmail, originalFrom, originalTo, originalCc, preserveCc } = params;
  const botLower = botEmail.toLowerCase();

  const botInTo = originalTo.some((addr) => addr.toLowerCase() === botLower);

  if (botInTo) {
    // Bot was in TO → reply to sender, preserve CC (minus bot)
    const to = [originalFrom];
    const cc = preserveCc
      ? [
          ...originalTo.filter(
            (addr) =>
              addr.toLowerCase() !== botLower && addr.toLowerCase() !== originalFrom.toLowerCase(),
          ),
          ...originalCc.filter(
            (addr) =>
              addr.toLowerCase() !== botLower && addr.toLowerCase() !== originalFrom.toLowerCase(),
          ),
        ]
      : [];
    return { to, cc };
  }

  // Bot was in CC → sender in TO, other CC recipients preserved (minus bot)
  const to = [originalFrom];
  const cc = preserveCc
    ? [
        ...originalTo.filter(
          (addr) =>
            addr.toLowerCase() !== botLower && addr.toLowerCase() !== originalFrom.toLowerCase(),
        ),
        ...originalCc.filter(
          (addr) =>
            addr.toLowerCase() !== botLower && addr.toLowerCase() !== originalFrom.toLowerCase(),
        ),
      ]
    : [];
  return { to, cc };
}

export function extractLatestContent(bodyText: string): string {
  if (!bodyText) {
    return "";
  }
  const lines = bodyText.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    if (/^On .+ wrote:$/i.test(line.trim())) {
      break;
    }
    if (/^-{2,}\s*Original Message/i.test(line.trim())) {
      break;
    }
    if (/^_{2,}$/.test(line.trim())) {
      break;
    }
    if (line.startsWith(">")) {
      continue;
    }
    result.push(line);
  }
  return result.join("\n").trim();
}
