import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "../shared/protocol.js";
import {
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
    expect(snapshot.conversations.at(-1)?.id).toBe(active.id);
  });
});
