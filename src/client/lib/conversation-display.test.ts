import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../../shared/protocol";
import {
  conversationDisplayTitle,
  conversationTargetTitle,
  conversationTitleLookupKey,
  createConversationTitleLookup,
} from "./conversation-display";

function summary(
  id: string,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    name: "会话标题",
    preview: "会话预览",
    createdAt: "2026-07-19T08:00:00.000Z",
    updatedAt: "2026-07-19T09:00:00.000Z",
    messageCount: 1,
    activity: { kind: "idle" },
    ...overrides,
  };
}

describe("conversation display titles", () => {
  it("uses the shared fallback, clipping, duplicate, and unknown rules", () => {
    const first = summary("11111111-1111-4111-8111-111111111111", {
      name: "  重复标题  ",
    });
    const second = summary("22222222-2222-4222-8222-222222222222", {
      name: undefined,
      preview: "重复标题",
    });
    const untitled = summary("33333333-3333-4333-8333-333333333333", {
      name: " ",
      preview: " ",
    });
    const lookup = createConversationTitleLookup([
      second,
      untitled,
      first,
    ], false);

    expect(conversationDisplayTitle(summary("long", {
      name: "会".repeat(30),
    }))).toBe(`${"会".repeat(23)}…`);
    expect(lookup.get(first.id)).toBe("重复标题 #11111111");
    expect(lookup.get(second.id)).toBe("重复标题 #22222222");
    expect(lookup.get(untitled.id)).toBe("新会话");
    expect(conversationTargetTitle(
      lookup,
      "99999999-9999-4999-8999-999999999999",
    )).toBe("未知会话 #99999999");
  });

  it("keys lookup identity by project, truncation mode, and final-title facts", () => {
    const first = summary("11111111-1111-4111-8111-111111111111");
    const second = summary("22222222-2222-4222-8222-222222222222", {
      name: "另一个会话",
    });
    const baseline = conversationTitleLookupKey(
      "project-a",
      [first, second],
      false,
    );

    expect(conversationTitleLookupKey("project-a", [
      {
        ...second,
        activity: { kind: "running", runId: "run-1" },
        updatedAt: "2026-07-19T12:00:00.000Z",
      },
      { ...first, attention: true, unread: true },
    ], false)).toBe(baseline);
    for (const changed of [
      [{ ...first, name: "已改名" }, second],
      [first, second, summary("33333333-3333-4333-8333-333333333333")],
      [first],
    ]) {
      expect(conversationTitleLookupKey("project-a", changed, false))
        .not.toBe(baseline);
    }
    expect(conversationTitleLookupKey("project-b", [first, second], false))
      .not.toBe(baseline);
    expect(conversationTitleLookupKey("project-a", [first, second], true))
      .not.toBe(baseline);

    const omittedDuplicate = { ...second, name: first.name };
    const truncatedLookup = createConversationTitleLookup([first], true);
    expect(truncatedLookup.get(first.id)).toBe("会话标题 #11111111");
    expect(conversationTargetTitle(
      truncatedLookup,
      omittedDuplicate.id,
    )).toBe("未知会话 #22222222");
  });
});
