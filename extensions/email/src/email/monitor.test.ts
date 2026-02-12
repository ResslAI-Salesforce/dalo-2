import { describe, expect, it } from "vitest";
import {
  buildDefaultEmailHookUrl,
  ensureEmailHookUrlAccountId,
  extractInboundMessageIds,
} from "./monitor.js";

describe("extractInboundMessageIds", () => {
  it("reads message ids from top-level payload fields", () => {
    expect(extractInboundMessageIds({ messageId: "m1" })).toEqual(["m1"]);
    expect(extractInboundMessageIds({ messageIds: ["m1", "m2"] })).toEqual(["m1", "m2"]);
  });

  it("reads message ids from nested message objects", () => {
    const ids = extractInboundMessageIds({
      messages: [{ id: "m1" }, { messageId: "m2" }],
      data: {
        messageId: "m3",
        messages: [{ id: "m4" }],
      },
    });
    expect(ids).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("dedupes and ignores blank/non-string ids", () => {
    const ids = extractInboundMessageIds({
      messageId: "m1",
      messageIds: ["", "m1", "m2", 5],
      messages: [{ id: "m2" }, { messageId: "   " }],
      data: {
        messageIds: ["m2", "m3"],
      },
    });
    expect(ids).toEqual(["m1", "m2", "m3"]);
  });
});

describe("buildDefaultEmailHookUrl", () => {
  it("uses plain inbound url for default account", () => {
    expect(buildDefaultEmailHookUrl(18789, "default")).toBe("http://127.0.0.1:18789/email/inbound");
  });

  it("adds encoded accountId for non-default accounts", () => {
    expect(buildDefaultEmailHookUrl(18789, "sales+na")).toBe(
      "http://127.0.0.1:18789/email/inbound?accountId=sales%2Bna",
    );
  });
});

describe("ensureEmailHookUrlAccountId", () => {
  it("keeps default account urls unchanged", () => {
    expect(ensureEmailHookUrlAccountId("http://127.0.0.1:18789/email/inbound", "default")).toBe(
      "http://127.0.0.1:18789/email/inbound",
    );
  });

  it("adds accountId query for non-default account urls", () => {
    expect(ensureEmailHookUrlAccountId("http://127.0.0.1:18789/email/inbound", "sales+na")).toBe(
      "http://127.0.0.1:18789/email/inbound?accountId=sales%2Bna",
    );
  });

  it("preserves existing query params", () => {
    expect(
      ensureEmailHookUrlAccountId("http://127.0.0.1:18789/email/inbound?token=abc", "sales+na"),
    ).toBe("http://127.0.0.1:18789/email/inbound?token=abc&accountId=sales%2Bna");
  });
});
