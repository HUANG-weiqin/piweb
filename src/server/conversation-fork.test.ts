import { randomUUID } from "node:crypto";
import {
  SessionManager,
  convertToLlm,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  applyForkSeedToManager,
  buildForkChildProfile,
  createForkSourceSnapshot,
  planForkEntries,
  type ForkSourceSnapshot,
} from "./conversation-fork.js";
import { FORK_CONTEXT_CUSTOM_TYPE } from "./conversation-meta.js";
import { createConversationMetaEntry } from "./conversation-meta.js";

function testProfile() {
  return {
    role: {
      id: "default",
      revision: 1,
      name: "Worker",
      description: "Builds focused changes",
      systemPrompt: "Keep changes small.",
      model: { provider: "openai", id: "gpt-test" },
      compactionModel: null,
      defaultThinkingLevel: "medium" as const,
      defaultServiceTier: null,
      toolMode: "read_only" as const,
      canManageSessions: false,
    },
    lifecycle: { kind: "normal" as const },
    createdBy: { kind: "user" as const },
  };
}

function user(text: string, timestamp = 1) {
  return { role: "user", content: text, timestamp } as never;
}

function assistant(text: string, timestamp = 2) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as never;
}

function snapshotOf(
  manager: SessionManager,
  overrides: Partial<ForkSourceSnapshot> = {},
): ForkSourceSnapshot {
  return createForkSourceSnapshot({
    sourceConversationId: manager.getSessionId(),
    sourceLeafId: manager.getLeafId(),
    branch: manager.getBranch(),
    profile: testProfile(),
    thinkingLevel: "medium",
    serviceTier: null,
    compactionThresholdPercent: 70,
    capturedAt: new Date().toISOString(),
    sessionName: manager.getSessionName(),
    ...overrides,
  });
}

function llmComparable(messages: Parameters<typeof convertToLlm>[0]) {
  // Timestamps differ by construction (fresh child entries); only role/content
  // define the acceptance equivalence.
  return convertToLlm(messages).map((message) => {
    const { timestamp: _ignored, ...rest } = message as Record<string, unknown>;
    return rest;
  });
}

describe("current-leaf fork", () => {
  it("copies messages without compaction and drops ledger entries", () => {
    const source = SessionManager.inMemory("E:\\work", { id: `fork${Date.now()}a` });
    source.appendMessage(user("hello"));
    source.appendMessage(assistant("world"));
    source.appendCustomEntry("piweb.conversation_card.v1", { cardId: randomUUID() });
    source.appendCustomEntry("piweb.run_settlement.v1", { runId: randomUUID() });
    const before = structuredClone(source.getBranch());

    const snapshot = snapshotOf(source);
    const planned = planForkEntries(snapshot);
    expect(planned.latestCompaction).toBeNull();
    expect(planned.post).toHaveLength(2);

    const child = SessionManager.inMemory("E:\\work", { id: randomUUID() });
    const applied = applyForkSeedToManager(child, snapshot, {
      forkedAt: new Date().toISOString(),
      compactionThresholdUpdatedAt: new Date().toISOString(),
      serviceTierUpdatedAt: new Date().toISOString(),
    });
    expect(applied.compactionEntryId).toBeNull();
    expect(child.getSessionName()).toBeUndefined();

    const childMessages = child.buildSessionContext().messages;
    const sourceMessages = source.buildSessionContext().messages;
    expect(llmComparable(childMessages)).toEqual(llmComparable(sourceMessages));
    expect(JSON.stringify(source.getBranch())).toEqual(JSON.stringify(before));

    const childEntries = child.getEntries();
    expect(childEntries.some((entry) => entry.type === "custom")).toBe(true);
    // Ledger kinds never enter the child.
    for (const entry of childEntries) {
      if (entry.type !== "custom") continue;
      expect(entry.customType).not.toBe("piweb.conversation_card.v1");
      expect(entry.customType).not.toBe("piweb.run_settlement.v1");
    }
  });

  it("keeps latest compaction, drops covered text, and remaps firstKept", () => {
    const source = SessionManager.inMemory("E:\\work");
    const oldId = source.appendMessage(user("OLD_COVERED_SENTINEL"));
    const retainedId = source.appendMessage(user("RETAINED_SENTINEL"));
    const compactionId = source.appendCompaction(
      "SUMMARY_SENTINEL",
      retainedId,
      123,
      { provenance: "test" },
      false,
      undefined,
    );
    source.appendMessage(user("POST_SENTINEL"));
    void oldId;
    void compactionId;

    const snapshot = snapshotOf(source);
    const planned = planForkEntries(snapshot);
    expect(planned.latestCompaction?.summary).toBe("SUMMARY_SENTINEL");
    expect(planned.retained.map((entry) => {
      if (entry.kind === "message") return (entry.message as { content: unknown }).content;
      return entry.content;
    })).toContain("RETAINED_SENTINEL");

    const child = SessionManager.inMemory("E:\\work", { id: randomUUID() });
    const applied = applyForkSeedToManager(child, snapshot, {
      forkedAt: new Date().toISOString(),
      compactionThresholdUpdatedAt: new Date().toISOString(),
      serviceTierUpdatedAt: new Date().toISOString(),
    });
    expect(applied.compactionEntryId).not.toBeNull();

    const raw = JSON.stringify(child.getEntries());
    expect(raw).not.toContain("OLD_COVERED_SENTINEL");
    expect(raw).toContain("SUMMARY_SENTINEL");
    expect(raw).toContain("RETAINED_SENTINEL");
    expect(raw).toContain("POST_SENTINEL");

    const compaction = child.getEntries().find((entry) => entry.type === "compaction");
    expect(compaction?.type).toBe("compaction");
    if (compaction?.type === "compaction") {
      expect(compaction.firstKeptEntryId).toBe(applied.firstKeptEntryId);
      const byId = new Map(child.getEntries().map((entry) => [entry.id, entry]));
      let current = byId.get(compaction.id);
      const ancestors = new Set<string>();
      while (current) {
        ancestors.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      expect(ancestors.has(compaction.firstKeptEntryId)).toBe(true);
      expect(compaction.tokensBefore).toBe(123);
    }

    expect(llmComparable(child.buildSessionContext().messages)).toEqual(
      llmComparable(source.buildSessionContext().messages),
    );
  });

  it("normalizes older compactions, branch summaries, and incoming messages", () => {
    const source = SessionManager.inMemory("E:\\work");
    source.appendMessage(user("base"));
    const firstKept = source.appendMessage(user("kept"));
    source.appendCompaction("FIRST_SUMMARY", firstKept, 10);
    source.appendMessage(user("mid"));
    const branchFrom = source.getLeafId()!;
    source.branchWithSummary(branchFrom, "BRANCH_SUMMARY_TEXT", undefined, false, undefined);
    source.appendCustomMessageEntry(
      "piweb.conversation_message.v1",
      "INCOMING_BODY",
      true,
      {
        messageId: randomUUID(),
        cardId: randomUUID(),
        sentAt: new Date().toISOString(),
        kind: "message",
        body: "INCOMING_BODY",
        fromSnapshot: { conversationId: randomUUID(), role: { id: "default", name: "W" } },
        toSnapshot: { conversationId: source.getSessionId(), role: { id: "default", name: "W" } },
      },
    );
    const latestKept = source.getBranch().find((entry) => {
      return entry.type === "message"
        && typeof entry.message === "object"
        && entry.message !== null
        && "content" in entry.message
        && entry.message.content === "mid";
    })!.id;
    source.appendCompaction("LATEST_SUMMARY", latestKept, 20);
    source.appendMessage(user("post"));

    const snapshot = snapshotOf(source);
    const child = SessionManager.inMemory("E:\\work", { id: randomUUID() });
    applyForkSeedToManager(child, snapshot, {
      forkedAt: new Date().toISOString(),
      compactionThresholdUpdatedAt: new Date().toISOString(),
      serviceTierUpdatedAt: new Date().toISOString(),
    });

    const entries = child.getEntries();
    const compactions = entries.filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect((compactions[0] as { summary: string }).summary).toBe("LATEST_SUMMARY");

    const forkContexts = entries.filter((entry) => (
      entry.type === "custom_message"
      && (entry as { customType: string }).customType === FORK_CONTEXT_CUSTOM_TYPE
    ));
    // Branch summary + incoming custom message (the older compaction is
    // covered by the latest compaction and never enters the child).
    expect(forkContexts).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain("FIRST_SUMMARY");
    const forkRaw = JSON.stringify(forkContexts);
    expect(forkRaw).not.toContain("piweb.conversation_message.v1");
    expect(forkRaw).not.toContain("fromId");

    expect(llmComparable(child.buildSessionContext().messages)).toEqual(
      llmComparable(source.buildSessionContext().messages),
    );
  });

  it("preserves toolCall/toolResult pairing across the fork", () => {
    const source = SessionManager.inMemory("E:\\work");
    source.appendMessage(user("run tool"));
    source.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
      api: "test",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    } as never);
    source.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: "file body",
      isError: false,
      timestamp: 3,
    } as never);

    const snapshot = snapshotOf(source);
    const child = SessionManager.inMemory("E:\\work", { id: randomUUID() });
    applyForkSeedToManager(child, snapshot, {
      forkedAt: new Date().toISOString(),
      compactionThresholdUpdatedAt: new Date().toISOString(),
      serviceTierUpdatedAt: new Date().toISOString(),
    });

    const messages = child.buildSessionContext().messages;
    const assistant = messages.find((message) => message.role === "assistant") as {
      content: Array<{ type: string; id?: string }>;
    };
    const toolResult = messages.find((message) => message.role === "toolResult") as {
      toolCallId: string;
    };
    expect(assistant.content.find((part) => part.type === "toolCall")?.id).toBe("call-1");
    expect(toolResult.toolCallId).toBe("call-1");
    expect(llmComparable(messages)).toEqual(llmComparable(source.buildSessionContext().messages));
  });

  it("builds an independent child profile with fork provenance", () => {
    const source = SessionManager.inMemory("E:\\work");
    const snapshot = snapshotOf(source, {
      profile: {
        ...testProfile(),
        createdBy: { kind: "conversation", conversationId: randomUUID() },
        orchestration: { rootConversationId: randomUUID(), depth: 2 },
      } as never,
    });
    const forkedAt = new Date().toISOString();
    const childProfile = buildForkChildProfile(snapshot, forkedAt, "leaf-1");
    expect(childProfile.createdBy).toEqual({ kind: "user" });
    expect(childProfile.orchestration).toBeUndefined();
    expect(childProfile.forkedFrom).toMatchObject({
      sourceConversationId: snapshot.sourceConversationId,
      sourceLeafId: "leaf-1",
      forkedAt,
    });
    expect(() => createConversationMetaEntry(childProfile)).not.toThrow();
  });

  it("fails closed when the latest compaction points outside the branch", () => {
    const source = SessionManager.inMemory("E:\\work");
    source.appendMessage(user("only"));
    const branch = [...source.getBranch()];
    (branch as SessionEntry[]).push({
      type: "compaction",
      id: "badcomp",
      parentId: branch.at(-1)!.id,
      timestamp: new Date().toISOString(),
      summary: "bad",
      firstKeptEntryId: "missing-id",
      tokensBefore: 1,
    } as SessionEntry);
    const snapshot = snapshotOf(source, { branch });
    expect(() => planForkEntries(snapshot)).toThrow();
  });

  it("carries an older compaction inside the retained range as fork context", () => {
    const source = SessionManager.inMemory("E:\\work");
    source.appendMessage(user("m0"));
    const keptId = source.getLeafId()!;
    source.appendCompaction("RETAINED_OLD_SUMMARY", keptId, 11);
    source.appendMessage(user("m1"));
    source.appendCompaction("RETAINED_LATEST_SUMMARY", keptId, 22);
    source.appendMessage(user("m2"));

    const snapshot = snapshotOf(source);
    const planned = planForkEntries(snapshot);
    expect(planned.latestCompaction?.summary).toBe("RETAINED_LATEST_SUMMARY");
    expect(planned.retained).toHaveLength(3);

    const child = SessionManager.inMemory("E:\\work", { id: randomUUID() });
    applyForkSeedToManager(child, snapshot, {
      forkedAt: new Date().toISOString(),
      compactionThresholdUpdatedAt: new Date().toISOString(),
      serviceTierUpdatedAt: new Date().toISOString(),
    });

    const entries = child.getEntries();
    const compactions = entries.filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect((compactions[0] as { summary: string }).summary)
      .toBe("RETAINED_LATEST_SUMMARY");
    const forkContexts = entries.filter((entry) => (
      entry.type === "custom_message"
      && (entry as { customType: string }).customType === FORK_CONTEXT_CUSTOM_TYPE
    ));
    expect(forkContexts).toHaveLength(1);
    expect(JSON.stringify(forkContexts)).toContain("RETAINED_OLD_SUMMARY");
    expect(llmComparable(child.buildSessionContext().messages)).toEqual(
      llmComparable(source.buildSessionContext().messages),
    );
  });

  it("fails closed when firstKept points after the latest compaction", () => {
    const source = SessionManager.inMemory("E:\\work");
    source.appendMessage(user("a"));
    source.appendMessage(user("b"));
    const branch = [...source.getBranch()];
    const postId = branch.at(-1)!.id;
    (branch as SessionEntry[]).splice(1, 0, {
      type: "compaction",
      id: "futurekept",
      parentId: branch[0]!.id,
      timestamp: new Date().toISOString(),
      summary: "future",
      firstKeptEntryId: postId,
      tokensBefore: 1,
    } as SessionEntry);
    const snapshot = snapshotOf(source, { branch });
    expect(() => planForkEntries(snapshot)).toThrow();
  });

  it("inherits the source session name without touching model context", () => {
    const source = SessionManager.inMemory("E:\\work", { id: randomUUID() });
    source.appendSessionInfo("Source Task");
    source.appendMessage(user("hello"));
    source.appendMessage(assistant("world"));
    const before = structuredClone(source.getBranch());

    const snapshot = snapshotOf(source);
    expect(snapshot.sessionName).toBe("Source Task");

    const child = SessionManager.inMemory("E:\\work", { id: randomUUID() });
    applyForkSeedToManager(child, snapshot, {
      forkedAt: new Date().toISOString(),
      compactionThresholdUpdatedAt: new Date().toISOString(),
      serviceTierUpdatedAt: new Date().toISOString(),
    });

    expect(child.getSessionName()).toBe("Source Task");
    expect(llmComparable(child.buildSessionContext().messages)).toEqual(
      llmComparable(source.buildSessionContext().messages),
    );
    expect(JSON.stringify(source.getBranch())).toEqual(JSON.stringify(before));
  });
});
