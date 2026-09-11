import { describe, expect, it } from "vitest";
import {
  MAX_PROJECT_CONVERSATIONS,
  type ConversationHistoryItem,
  type ConversationSummary,
  type PeerPresenceResolution,
} from "../shared/protocol.js";
import {
  conversationDisplayTitle,
  projectConversationIndex,
  projectConversationPeers,
} from "./project-snapshot.js";

function conversation(index: number): ConversationSummary {
  return {
    id: `0198f775-88f3-7af1-9c6a-${String(index).padStart(12, "0")}`,
    name: "n".repeat(140),
    preview: "p".repeat(600),
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:01:00.000Z",
    messageCount: index,
    compacting: false,
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

  it("keeps peer presence unknown without a census and applies only explicit proof", () => {
    const source = conversation(1);
    const target = { ...conversation(2), name: "Target" };
    const card = {
      kind: "session_message",
      id: "card-entry-1",
      cardId: "6790e721-6f5c-4692-8949-4d3fd2cf0dfc",
      direction: "outgoing",
      state: "queued",
      body: "Review the implementation.",
      from: { conversationId: source.id, role: { id: "lead", name: "Lead" } },
      to: { conversationId: target.id, role: { id: "reviewer", name: "Reviewer" } },
      sentAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
      peerPresence: "unknown",
    } satisfies ConversationHistoryItem;

    expect(projectConversationPeers([card], [target])[0]).toMatchObject({
      peerPresence: "unknown",
      to: { title: "Target" },
    });
    const presence = new Map<string, PeerPresenceResolution>([[target.id, "present"]]);
    expect(projectConversationPeers([card], [], presence)[0]).toMatchObject({
      peerPresence: "present",
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

  it("prioritizes the current, active, compacting, attention, and unread conversations", () => {
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
    const compacting = source.at(-3)!;
    const attention = source.at(-4)!;
    const unread = source.at(-5)!;
    active.activity = { kind: "running", runId: active.id };
    compacting.compacting = true;
    attention.attention = true;
    unread.unread = true;

    const snapshot = projectConversationIndex(source, current.id);
    const retainedIds = new Set(snapshot.conversations.map(({ id }) => id));

    expect(snapshot.conversations.slice(0, 5).map(({ id }) => id)).toEqual([
      current.id,
      active.id,
      compacting.id,
      attention.id,
      unread.id,
    ]);
    expect(retainedIds.has(current.id)).toBe(true);
    expect(retainedIds.has(active.id)).toBe(true);
    expect(retainedIds.has(compacting.id)).toBe(true);
    expect(retainedIds.has(attention.id)).toBe(true);
    expect(retainedIds.has(unread.id)).toBe(true);
    expect(snapshot.truncated).toBe(true);
  });

  it("retains an older group with a compacting member in a capped index", () => {
    const root = {
      ...conversation(10_000),
      name: "Compacting root",
      preview: "Compacting root",
      rootConversationId: conversation(10_000).id,
      updatedAt: "2026-07-18T08:00:00.000Z",
    };
    const compactingChild = {
      ...conversation(10_001),
      name: "Compacting child",
      preview: "Compacting child",
      rootConversationId: root.id,
      updatedAt: "2026-07-18T08:01:00.000Z",
      compacting: true,
    };
    const newerIdleSingletons = Array.from(
      { length: MAX_PROJECT_CONVERSATIONS - 1 },
      (_, index) => ({
        ...conversation(index),
        name: `Newer idle ${index}`,
        preview: `Newer idle ${index}`,
        updatedAt: new Date(
          Date.UTC(2026, 6, 18, 12, 0, index),
        ).toISOString(),
      }),
    );

    const snapshot = projectConversationIndex([
      ...newerIdleSingletons,
      root,
      compactingChild,
    ]);
    const retainedIds = new Set(snapshot.conversations.map(({ id }) => id));

    expect(snapshot.conversations).toHaveLength(MAX_PROJECT_CONVERSATIONS);
    expect(retainedIds.has(root.id)).toBe(true);
    expect(retainedIds.has(compactingChild.id)).toBe(true);
    expect(snapshot.conversations).toContainEqual(expect.objectContaining({
      id: compactingChild.id,
      compacting: true,
    }));
    expect(snapshot.truncated).toBe(true);
  });
});
