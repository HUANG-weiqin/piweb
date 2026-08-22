import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../shared/protocol.js";
import {
  conversationDisplayTitle,
  MAX_PROJECT_CONVERSATIONS,
  projectConversationIndex,
} from "./project-snapshot.js";

function conversation(index: number): ConversationSummary {
  return {
    id: `0198f775-88f3-7af1-9c6a-${String(index).padStart(12, "0")}`,
    name: "n".repeat(140),
    preview: "p".repeat(600),
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:01:00.000Z",
    messageCount: index,
  };
}

describe("projectConversationIndex", () => {
  it("derives a bounded display title from the name or preview", () => {
    expect(conversationDisplayTitle({
      name: "  Explicit name  ",
      preview: "Ignored preview",
    })).toBe("Explicit name");
    expect(conversationDisplayTitle({
      preview: "  Preview title  ",
    })).toBe("Preview title");
    const clipped = conversationDisplayTitle({
      preview: "会".repeat(140),
    });
    expect([...(clipped ?? "")]).toHaveLength(24);
    expect(clipped?.endsWith("…")).toBe(true);
  });

  it("bounds the browser projection without mutating the durable index", () => {
    const source = Array.from(
      { length: MAX_PROJECT_CONVERSATIONS + 1 },
      (_, index) => conversation(index),
    );
    const snapshot = projectConversationIndex(source);

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.conversations).toHaveLength(MAX_PROJECT_CONVERSATIONS);
    expect(snapshot.conversations[0]?.name?.endsWith("…")).toBe(true);
    expect(snapshot.conversations[0]?.preview.endsWith("…")).toBe(true);
    expect(source[0]?.name).toHaveLength(140);
    expect(source[0]?.preview).toHaveLength(600);
  });

  it("preserves a small index exactly", () => {
    const source = [{
      ...conversation(1),
      name: "Short",
      preview: "Short preview",
    }];

    expect(projectConversationIndex(source)).toEqual({
      conversations: source,
      truncated: false,
    });
  });

  it("keeps an older active conversation reachable in a capped index", () => {
    const source = Array.from(
      { length: MAX_PROJECT_CONVERSATIONS + 2 },
      (_, index) => ({
        ...conversation(index),
        name: `Conversation ${index}`,
        preview: `Preview ${index}`,
      }),
    );
    const active = source.at(-1)!;
    const snapshot = projectConversationIndex(source, active.id);

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.conversations).toHaveLength(MAX_PROJECT_CONVERSATIONS);
    expect(snapshot.conversations[0]?.id).toBe(active.id);
  });

  it("prioritizes the current, active, attention, and unread conversations", () => {
    const source = Array.from(
      { length: MAX_PROJECT_CONVERSATIONS + 20 },
      (_, index) => ({
        ...conversation(index),
        name: `Conversation ${index}`,
        preview: `Preview ${index}`,
        updatedAt: new Date(
          Date.UTC(2026, 6, 18, 12, 0, index),
        ).toISOString(),
      }),
    );
    const current = source.at(-1)!;
    const active = source.at(-2)!;
    const attention = source.at(-3)!;
    const unread = source.at(-4)!;
    active.activity = { kind: "running", runId: active.id };
    attention.attention = true;
    unread.unread = true;

    const snapshot = projectConversationIndex(source, current.id);
    const retainedIds = new Set(snapshot.conversations.map(({ id }) => id));

    expect(snapshot.conversations.slice(0, 4).map(({ id }) => id)).toEqual([
      current.id,
      active.id,
      attention.id,
      unread.id,
    ]);
    expect(retainedIds.has(current.id)).toBe(true);
    expect(retainedIds.has(active.id)).toBe(true);
    expect(retainedIds.has(attention.id)).toBe(true);
    expect(retainedIds.has(unread.id)).toBe(true);
    expect(snapshot.truncated).toBe(true);
  });
});
