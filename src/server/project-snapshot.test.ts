import { describe, expect, it } from "vitest";
import {
  MAX_PROJECT_CONVERSATIONS,
  type ConversationSummary,
} from "../shared/protocol.js";
import {
  conversationDisplayTitle,
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

  it("clips project index strings by code point without splitting astral characters", () => {
    const emoji = "😀";
    const atLimit = projectConversationIndex([{
      ...conversation(1),
      name: emoji.repeat(24),
      preview: emoji.repeat(500),
    }]);
    expect(atLimit.conversations[0]?.name).toBe(emoji.repeat(24));
    expect(atLimit.conversations[0]?.preview).toBe(emoji.repeat(500));

    const clipped = projectConversationIndex([{
      ...conversation(1),
      name: emoji.repeat(25),
      preview: emoji.repeat(501),
    }]);
    expect([...clipped.conversations[0]!.name!]).toHaveLength(24);
    expect([...clipped.conversations[0]!.preview]).toHaveLength(500);
    expect(clipped.conversations[0]?.name).toBe(`${emoji.repeat(23)}…`);
    expect(clipped.conversations[0]?.preview).toBe(`${emoji.repeat(499)}…`);
    expect(() => encodeURIComponent(clipped.conversations[0]!.name!)).not.toThrow();
    expect(() => encodeURIComponent(clipped.conversations[0]!.preview)).not.toThrow();
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

  it("keeps count-truncated groups atomic and promotes the current child group", () => {
    const currentRoot = {
      ...conversation(1_000),
      name: "Current root",
      preview: "Current root",
      rootConversationId: conversation(1_000).id,
      updatedAt: "2026-07-18T09:00:00.000Z",
    };
    const currentChild = {
      ...conversation(1_001),
      name: "Current child",
      preview: "Current child",
      rootConversationId: currentRoot.id,
      updatedAt: "2026-07-18T09:01:00.000Z",
    };
    const newerSingletons = Array.from({ length: 97 }, (_, index) => ({
      ...conversation(index),
      name: `Singleton ${index}`,
      preview: `Singleton ${index}`,
      updatedAt: new Date(
        Date.UTC(2026, 6, 18, 12, 0, index),
      ).toISOString(),
    }));
    const cutoffRoot = {
      ...conversation(2_000),
      name: "Cutoff root",
      preview: "Cutoff root",
      rootConversationId: conversation(2_000).id,
      updatedAt: "2026-07-18T11:00:00.000Z",
    };
    const cutoffChild = {
      ...conversation(2_001),
      name: "Cutoff child",
      preview: "Cutoff child",
      rootConversationId: cutoffRoot.id,
      updatedAt: "2026-07-18T11:01:00.000Z",
    };
    const trailingSingleton = {
      ...conversation(3_000),
      name: "Trailing singleton",
      preview: "Trailing singleton",
      updatedAt: "2026-07-18T10:00:00.000Z",
    };

    const snapshot = projectConversationIndex([
      ...newerSingletons,
      cutoffRoot,
      cutoffChild,
      trailingSingleton,
      currentRoot,
      currentChild,
    ], currentChild.id);
    const retainedIds = new Set(snapshot.conversations.map(({ id }) => id));

    expect(snapshot.conversations).toHaveLength(MAX_PROJECT_CONVERSATIONS);
    expect(snapshot.conversations.slice(0, 2).map(({ id }) => id)).toEqual([
      currentChild.id,
      currentRoot.id,
    ]);
    expect(retainedIds.has(currentRoot.id)).toBe(true);
    expect(retainedIds.has(currentChild.id)).toBe(true);
    expect(retainedIds.has(cutoffRoot.id)).toBe(false);
    expect(retainedIds.has(cutoffChild.id)).toBe(false);
    expect(retainedIds.has(trailingSingleton.id)).toBe(true);
    expect(snapshot.truncated).toBe(true);
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
