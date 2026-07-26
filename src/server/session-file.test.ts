import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CARD_CUSTOM_TYPE,
  CONVERSATION_MESSAGE_CUSTOM_TYPE,
  CONVERSATION_META_CUSTOM_TYPE,
  RUN_SETTLEMENT_CUSTOM_TYPE,
  PENDING_PROMPT_DELIVERY_CUSTOM_TYPE,
  createConversationCardEntry,
  createConversationMessageEntry,
  createConversationMetaEntry,
  createPendingPromptDeliveryEntry,
  createRunSettlementEntry,
} from "./conversation-meta.js";
import {
  inspectPiSessionFile,
  validatePiSessionFile,
} from "./session-file.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function serialize(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function peer(conversationId = randomUUID()) {
  return {
    conversationId,
    title: "Worker",
    role: {
      id: "default",
      name: "Worker",
    },
  };
}

function metadata() {
  return {
    role: {
      id: "default",
      revision: 1,
      name: "Worker",
      description: "",
      systemPrompt: "",
      model: {
        provider: "openai",
        id: "gpt-5.6",
      },
    },
    lifecycle: {
      kind: "normal" as const,
    },
    createdBy: {
      kind: "user" as const,
    },
  };
}

describe("validatePiSessionFile", () => {
  it("accepts the current Pi entry variants and tree links", () => {
    const conversationId = randomUUID();
    const base = (type: string, id: string, parentId: string | null) => ({
      type,
      id,
      parentId,
      timestamp,
    });
    const entries = [
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      { ...base("thinking_level_change", "00000001", null), thinkingLevel: "high" },
      {
        ...base("model_change", "00000002", "00000001"),
        provider: "provider",
        modelId: "model",
      },
      {
        ...base("custom", "00000003", "00000002"),
        customType: "extension-state",
        data: { count: 1 },
      },
      {
        ...base("custom_message", "00000004", "00000003"),
        customType: "extension-context",
        content: "context",
        display: true,
      },
      {
        ...base("message", "00000005", "00000004"),
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        ...base("message", "00000006", "00000005"),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "test-api",
          provider: "provider",
          model: "model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        ...base("message", "00000007", "00000006"),
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        ...base("compaction", "00000008", "00000007"),
        summary: "summary",
        firstKeptEntryId: "00000005",
        tokensBefore: 100,
      },
      {
        ...base("branch_summary", "00000009", "00000005"),
        fromId: "00000008",
        summary: "other branch",
      },
      {
        ...base("label", "0000000a", "00000009"),
        targetId: "00000005",
        label: "checkpoint",
      },
      {
        ...base("session_info", "0000000b", "0000000a"),
        name: "Conversation",
      },
    ];

    expect(validatePiSessionFile(
      serialize(entries),
      "session.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it("validates legacy linear entries after Pi's in-memory migration", () => {
    const conversationId = randomUUID();
    const legacy = serialize([
      {
        type: "session",
        version: 1,
        id: conversationId,
        timestamp,
      },
      {
        type: "message",
        timestamp,
        message: { role: "user", content: "legacy" },
      },
      {
        type: "session_info",
        timestamp,
        name: "Legacy",
      },
    ]);

    expect(validatePiSessionFile(
      legacy,
      "legacy.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it("rejects negative compaction token counts before history projection", () => {
    const conversationId = randomUUID();
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      {
        type: "message",
        id: "00000001",
        parentId: null,
        timestamp,
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "00000002",
        parentId: "00000001",
        timestamp,
        summary: "summary",
        firstKeptEntryId: "00000001",
        tokensBefore: -1,
      },
    ]);

    expect(() => validatePiSessionFile(
      session,
      "negative-compaction.jsonl",
      conversationId,
    )).toThrow(/tokensBefore must be non-negative/i);
  });

  it("accepts Pi's root branch-summary sentinel", () => {
    const conversationId = randomUUID();
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "",
      },
      {
        type: "branch_summary",
        id: "00000001",
        parentId: null,
        timestamp,
        fromId: "root",
        summary: "root branch",
      },
    ]);

    expect(validatePiSessionFile(
      session,
      "root-branch.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it("rejects compaction state borrowed from another branch", () => {
    const conversationId = randomUUID();
    const base = (type: string, id: string, parentId: string | null) => ({
      type,
      id,
      parentId,
      timestamp,
    });
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      {
        ...base("message", "00000001", null),
        message: { role: "user", content: "root", timestamp: 1 },
      },
      {
        ...base("message", "00000002", "00000001"),
        message: { role: "user", content: "other branch", timestamp: 2 },
      },
      {
        ...base("message", "00000003", "00000001"),
        message: { role: "user", content: "active branch", timestamp: 3 },
      },
      {
        ...base("compaction", "00000004", "00000003"),
        summary: "invalid",
        firstKeptEntryId: "00000002",
        tokensBefore: 100,
      },
    ]);

    expect(() => validatePiSessionFile(
      session,
      "cross-branch-compaction.jsonl",
      conversationId,
    )).toThrow("firstKeptEntryId is not an ancestor");
  });

  it("inspects every physical branch and returns latest reserved state", () => {
    const conversationId = randomUUID();
    const cardId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    const firstCard = createConversationCardEntry({
      cardId,
      kind: "delegation_task",
      body: "Inspect the project",
      fromSnapshot: peer(conversationId),
      toSnapshot: peer(),
      state: "queued",
      messageId,
      runId,
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    const finalCard = createConversationCardEntry({
      ...firstCard.data,
      state: "completed",
      result: "Done",
      updatedAt: "2026-01-01T00:04:00.000Z",
    });
    const incoming = createConversationMessageEntry({
      content: "Inspect the project",
      display: true,
      details: {
        messageId,
        cardId: randomUUID(),
        sentAt: "2026-01-01T00:02:00.000Z",
        kind: "message",
        body: "Inspect the project",
        fromSnapshot: peer(),
        toSnapshot: peer(conversationId),
      },
    });
    const settlement = createRunSettlementEntry({
      runId,
      outcome: "completed",
      finalText: "Done",
      settledAt: "2026-01-01T00:03:00.000Z",
    });
    const delivery = createPendingPromptDeliveryEntry({
      promptId: randomUUID(),
      runId,
      deliveredAt: "2026-01-01T00:03:30.000Z",
    });
    const meta = createConversationMetaEntry(metadata());
    const base = (
      type: string,
      id: string,
      parentId: string | null,
      entryTimestamp = timestamp,
    ) => ({
      type,
      id,
      parentId,
      timestamp: entryTimestamp,
    });
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      {
        ...base("custom", "00000001", null),
        customType: CONVERSATION_META_CUSTOM_TYPE,
        data: meta.data,
      },
      {
        ...base("custom", "00000002", "00000001"),
        customType: CONVERSATION_CARD_CUSTOM_TYPE,
        data: firstCard.data,
      },
      {
        ...base("custom_message", "00000003", "00000001"),
        customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
        content: incoming.content,
        display: incoming.display,
        details: incoming.details,
      },
      {
        ...base("custom", "00000004", "00000003"),
        customType: RUN_SETTLEMENT_CUSTOM_TYPE,
        data: settlement.data,
      },
      {
        ...base("custom_message", "00000005", "00000004"),
        customType: "piweb.compaction_resume.v1",
        content:
          "Continue the unfinished task from the retained context.",
        display: false,
        details: { runId },
      },
      {
        ...base(
          "custom",
          "00000006",
          "00000002",
          "2026-01-01T00:05:00.000Z",
        ),
        customType: CONVERSATION_CARD_CUSTOM_TYPE,
        data: finalCard.data,
      },
      {
        ...base("custom", "00000007", "00000006"),
        customType: PENDING_PROMPT_DELIVERY_CUSTOM_TYPE,
        data: delivery.data,
      },
    ]);

    expect(inspectPiSessionFile(
      session,
      "reserved.jsonl",
      conversationId,
    )).toEqual({
      conversationId,
      conversationMeta: meta.data,
      cards: [finalCard.data],
      deliveredMessageIds: [messageId],
      runSettlements: [settlement.data],
      pendingPromptDeliveries: [delivery.data],
      temporaryReturnReceipts: [],
      metaOperations: [],
      lastActivityAt: "2026-01-01T00:05:00.000Z",
    });
    expect(validatePiSessionFile(
      session,
      "reserved.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it("fails closed when physical card updates rewrite identity or regress state", () => {
    const conversationId = randomUUID();
    const initial = createConversationCardEntry({
      cardId: randomUUID(),
      kind: "delegation_task",
      body: "Keep this durable identity",
      fromSnapshot: peer(conversationId),
      toSnapshot: peer(),
      state: "queued",
      messageId: randomUUID(),
      delegationId: randomUUID(),
      requestFingerprint: "a".repeat(64),
      requestedRole: metadata().role,
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    const sessionWith = (update: ReturnType<
      typeof createConversationCardEntry
    >) => serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      {
        type: "custom",
        id: "00000001",
        parentId: null,
        timestamp: initial.data.updatedAt,
        customType: CONVERSATION_CARD_CUSTOM_TYPE,
        data: initial.data,
      },
      {
        type: "custom",
        id: "00000002",
        parentId: "00000001",
        timestamp: update.data.updatedAt,
        customType: CONVERSATION_CARD_CUSTOM_TYPE,
        data: update.data,
      },
    ]);

    expect(() => inspectPiSessionFile(
      sessionWith(createConversationCardEntry({
        ...initial.data,
        requestedRole: {
          ...initial.data.requestedRole!,
          systemPrompt: "A rewritten prompt",
        },
        updatedAt: "2026-01-01T00:02:00.000Z",
      })),
      "mutated-card.jsonl",
      conversationId,
    )).toThrow(/card identity/i);
    expect(() => validatePiSessionFile(
      sessionWith(createConversationCardEntry({
        ...initial.data,
        state: "sending",
        updatedAt: "2026-01-01T00:02:00.000Z",
      })),
      "regressed-card.jsonl",
      conversationId,
    )).toThrow(/state cannot regress/i);
  });

  it("fails closed for unknown or incorrectly-carried reserved entries", () => {
    const conversationId = randomUUID();
    const header = {
      type: "session",
      version: 3,
      id: conversationId,
      timestamp,
      cwd: "E:\\work",
    };
    const base = {
      id: "00000001",
      parentId: null,
      timestamp,
    };

    expect(() => inspectPiSessionFile(serialize([
      header,
      {
        ...base,
        type: "custom",
        customType: "piweb.future.v2",
        data: {},
      },
    ]), "unknown.jsonl")).toThrow(/unknown piweb reserved/i);

    expect(() => inspectPiSessionFile(serialize([
      header,
      {
        ...base,
        type: "custom",
        customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
        data: {},
      },
    ]), "wrong-carrier.jsonl")).toThrow();

    expect(() => inspectPiSessionFile(serialize([
      header,
      {
        ...base,
        type: "message",
        message: {
          role: "custom",
          customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
          content: "hidden",
          display: true,
        },
      },
    ]), "nested-carrier.jsonl")).toThrow(/nested message\.role=custom/i);
  });

  it("detects duplicate delivery identities even when one is off the active branch", () => {
    const conversationId = randomUUID();
    const incoming = createConversationMessageEntry({
      content: "message",
      display: true,
      details: {
        messageId: randomUUID(),
        cardId: randomUUID(),
        sentAt: timestamp,
        kind: "message",
        body: "message",
        fromSnapshot: peer(),
        toSnapshot: peer(conversationId),
      },
    });
    const rawIncoming = (
      id: string,
      parentId: string | null,
    ) => ({
      type: "custom_message",
      id,
      parentId,
      timestamp,
      customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
      content: incoming.content,
      display: incoming.display,
      details: incoming.details,
    });
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      rawIncoming("00000001", null),
      rawIncoming("00000002", null),
      {
        type: "message",
        id: "00000003",
        parentId: "00000001",
        timestamp,
        message: {
          role: "user",
          content: "active branch",
          timestamp: 1,
        },
      },
    ]);

    expect(() => inspectPiSessionFile(
      session,
      "duplicate-delivery.jsonl",
    )).toThrow(/duplicate delivered piweb messageId/i);
  });
});
