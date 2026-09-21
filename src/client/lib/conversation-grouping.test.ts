import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../../shared/protocol";
import {
  conversationDisplayOrdinal,
  groupConversations,
} from "./conversation-grouping";

function conversation(
  id: string,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    preview: id,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    messageCount: 0,
    activity: { kind: "idle" },
    compacting: false,
    ...overrides,
  };
}

describe("groupConversations", () => {
  it("keeps valid hierarchies together while sorting entries and members independently", () => {
    const root = conversation("root");
    const attention = conversation("attention", {
      rootConversationId: root.id,
      attention: true,
    });
    const running = conversation("running", {
      rootConversationId: root.id,
      activity: { kind: "running", runId: "run-1" },
    });
    const waiting = conversation("waiting", {
      rootConversationId: root.id,
      activity: { kind: "waiting", runId: "run-2", targetCount: 1 },
    });
    const busy = conversation("busy", { rootConversationId: root.id });
    const unread = conversation("unread", {
      rootConversationId: root.id,
      unread: true,
    });
    const self = conversation("self", {
      rootConversationId: "self",
      createdAt: "2026-09-01T11:00:00.000Z",
    });
    const orphan = conversation("orphan", {
      rootConversationId: "missing",
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    const conversations = [
      unread,
      orphan,
      busy,
      root,
      self,
      waiting,
      attention,
      running,
    ];

    const grouped = groupConversations(conversations, busy.id);

    expect(grouped.entries.map((entry) => (
      entry.kind === "group" ? entry.group.root.id : entry.conversation.id
    ))).toEqual([orphan.id, self.id, root.id]);
    const rootEntry = grouped.entries[2];
    expect(rootEntry?.kind).toBe("group");
    if (rootEntry?.kind !== "group") throw new Error("expected root group");
    expect(rootEntry.group.members.map(({ id }) => id)).toEqual([
      attention.id,
      running.id,
      waiting.id,
      busy.id,
      unread.id,
    ]);
    expect([...grouped.rootByConversationId]).toEqual([
      [root.id, root.id],
      [attention.id, root.id],
      [running.id, root.id],
      [waiting.id, root.id],
      [busy.id, root.id],
      [unread.id, root.id],
    ]);
    expect(conversationDisplayOrdinal(conversations, waiting.id)).toBe(3);
    expect(conversationDisplayOrdinal(conversations, "missing")).toBeUndefined();
  });
});
