import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CARD_CUSTOM_TYPE,
  CONVERSATION_MESSAGE_CUSTOM_TYPE,
  CONVERSATION_META_CUSTOM_TYPE,
  RUN_SETTLEMENT_CUSTOM_TYPE,
  LOOP_LIST_CUSTOM_TYPE,
  MESSAGE_DELIVERY_RECEIPT_CUSTOM_TYPE,
  createConversationCardEntry,
  createConversationMessageEntry,
  createConversationMetaEntry,
  createLoopListContinueEntry,
  createLoopListEntry,
  createMessageDeliveryReceiptEntry,
  createRunSettlementEntry,
} from "./conversation-meta.js";
import {
  createReadonlySessionEntriesAdapter,
  inspectPiSessionFile,
  inspectPiSessionFilePresentation,
  validatePiSessionFile,
} from "./session-file.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function serialize(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

type LoopListItems = Parameters<typeof createLoopListEntry>[0]["items"];

function loopListStateEntry(
  id: string,
  parentId: string | null,
  items: LoopListItems,
  updatedAt = timestamp,
) {
  return {
    type: "custom",
    id,
    parentId,
    timestamp,
    ...createLoopListEntry({ items, armed: true, updatedAt }),
  };
}

function loopListContinuationEntry(
  id: string,
  parentId: string,
  runId: string,
  continuation: number,
  items: LoopListItems,
) {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp,
    ...createLoopListContinueEntry({ runId, continuation, items }),
  };
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
      compactionModel: null,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
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

  it.each([
    { name: "old", version: 1 },
    { name: "missing", version: undefined },
    { name: "future", version: CURRENT_SESSION_VERSION + 1 },
  ])("rejects $name session header versions", ({ version }) => {
    const conversationId = randomUUID();
    const session = serialize([
      {
        type: "session",
        ...(version === undefined ? {} : { version }),
        id: conversationId,
        timestamp,
      },
    ]);

    expect(() => inspectPiSessionFile(
      session,
      `${version ?? "missing"}-version.jsonl`,
      conversationId,
    )).toThrow(/unsupported header version/i);
  });

  it("returns shallow readonly arrays and follows the final leaf active branch", () => {
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
        message: { role: "user", content: "root", timestamp: 1 },
      },
      {
        type: "message",
        id: "00000002",
        parentId: "00000001",
        timestamp,
        message: { role: "user", content: "inactive", timestamp: 2 },
      },
      {
        type: "message",
        id: "00000003",
        parentId: "00000001",
        timestamp,
        message: { role: "user", content: "active", timestamp: 3 },
      },
      {
        type: "session_info",
        id: "00000004",
        parentId: "00000003",
        timestamp,
        name: "Current leaf",
      },
    ]);
    const inspection = inspectPiSessionFilePresentation(
      session,
      "branch.jsonl",
    );
    const adapter = createReadonlySessionEntriesAdapter(inspection.entries);

    expect(adapter.getBranch().map(({ id }) => id)).toEqual([
      "00000001",
      "00000003",
      "00000004",
    ]);
    const returned = adapter.getEntries();
    expect(returned).not.toBe(adapter.getEntries());
    expect(returned[0]).toBe(inspection.entries[0]);
    expect(adapter.getBranch()[0]).toBe(inspection.entries[0]);
  });

  it("does not recursively copy deeply nested entries during validation or opt-in presentation", () => {
    const conversationId = randomUUID();
    const depth = 2_500;
    const nested = `${'{"next":'.repeat(depth)}null${"}".repeat(depth)}`;
    const raw = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      }),
      `{"type":"custom","id":"00000001","parentId":null,"timestamp":"${timestamp}","customType":"extension-state","data":${nested}}`,
      "",
    ].join("\n");

    expect(validatePiSessionFile(raw, "deep.jsonl", conversationId)).toBe(
      conversationId,
    );
    expect(inspectPiSessionFile(raw, "deep.jsonl", conversationId))
      .not.toHaveProperty("entries");
    expect(inspectPiSessionFilePresentation(
      raw,
      "deep.jsonl",
      conversationId,
    ).entries).toHaveLength(1);
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
    const receipt = createMessageDeliveryReceiptEntry({
      messageId,
      cardId: incoming.details.cardId,
      fromConversationId: incoming.details.fromSnapshot.conversationId,
      toConversationId: conversationId,
      sourceRunId: randomUUID(),
      targetRunId: runId,
      kind: incoming.details.kind,
      sentAt: incoming.details.sentAt,
      payloadFingerprint: "b".repeat(64),
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
        ...base("custom", "00000009", "00000006"),
        customType: MESSAGE_DELIVERY_RECEIPT_CUSTOM_TYPE,
        data: receipt.data,
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
      messageDeliveryReceipts: [receipt.data],
      runSettlements: [settlement.data],
      temporaryReturnReceipts: [],
      editBudgetEvents: [],
      metaOperations: [],
      lastActivityAt: "2026-01-01T00:05:00.000Z",
    });
    expect(validatePiSessionFile(
      session,
      "reserved.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it("accepts exact LoopList continuation snapshots and numbering on a branch", () => {
    const conversationId = randomUUID();
    const runId = randomUUID();
    const initialItems = [
      { id: "implement", text: "Implement the change", status: "active" as const },
    ];
    const updatedItems = [
      { id: "implement", text: "Verify the change", status: "pending" as const },
    ];
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      loopListStateEntry("00000001", null, initialItems),
      loopListContinuationEntry(
        "00000002",
        "00000001",
        runId,
        1,
        initialItems,
      ),
      loopListStateEntry(
        "00000003",
        "00000002",
        updatedItems,
        "2026-01-01T00:01:00.000Z",
      ),
      loopListContinuationEntry(
        "00000004",
        "00000003",
        runId,
        2,
        updatedItems,
      ),
      loopListContinuationEntry(
        "00000005",
        "00000001",
        runId,
        1,
        initialItems,
      ),
    ]);

    expect(validatePiSessionFile(
      session,
      "valid-loop-list-continuations.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it.each([
    {
      name: "whose item snapshot differs from the latest LoopList",
      continuations: (runId: string, items: LoopListItems) => [
        loopListContinuationEntry(
          "00000002",
          "00000001",
          runId,
          1,
          [{ ...items[0]!, text: "Tampered work" }],
        ),
      ],
      error: /snapshot must match/i,
    },
    {
      name: "whose numbering does not start at one",
      continuations: (runId: string, items: LoopListItems) => [
        loopListContinuationEntry(
          "00000002",
          "00000001",
          runId,
          2,
          items,
        ),
      ],
      error: /must be 1/i,
    },
    {
      name: "whose numbering skips along the branch",
      continuations: (runId: string, items: LoopListItems) => [
        loopListContinuationEntry(
          "00000002",
          "00000001",
          runId,
          1,
          items,
        ),
        loopListContinuationEntry(
          "00000003",
          "00000002",
          runId,
          3,
          items,
        ),
      ],
      error: /must be 2/i,
    },
  ])("rejects a LoopList continuation $name", ({ continuations, error }) => {
    const conversationId = randomUUID();
    const runId = randomUUID();
    const items = [
      { id: "implement", text: "Implement the change", status: "active" as const },
    ];
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      loopListStateEntry("00000001", null, items),
      ...continuations(runId, items),
    ]);

    expect(() => validatePiSessionFile(
      session,
      "malformed-loop-list-continuation.jsonl",
      conversationId,
    )).toThrow(error);
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
        type: "custom",
        customType: LOOP_LIST_CUSTOM_TYPE,
        data: {
          items: [
            { id: "duplicate", text: "first", status: "pending" },
            { id: "duplicate", text: "second", status: "active" },
          ],
          armed: true,
          updatedAt: timestamp,
        },
      },
    ]), "malformed-loop-list.jsonl")).toThrow(/unique/i);

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

    const foreignCard = createConversationCardEntry({
      cardId: randomUUID(),
      kind: "message",
      body: "not owned by this conversation",
      fromSnapshot: peer(),
      toSnapshot: peer(),
      state: "queued",
      messageId: randomUUID(),
      updatedAt: timestamp,
    });
    expect(() => inspectPiSessionFile(serialize([
      header,
      {
        ...base,
        type: "custom",
        customType: CONVERSATION_CARD_CUSTOM_TYPE,
        data: foreignCard.data,
      },
    ]), "foreign-card.jsonl")).toThrow(/card source.*current conversation/i);

    const foreignMessage = createConversationMessageEntry({
      content: "not delivered to this conversation",
      display: true,
      details: {
        messageId: randomUUID(),
        cardId: randomUUID(),
        sentAt: timestamp,
        kind: "message",
        body: "not delivered to this conversation",
        fromSnapshot: peer(),
        toSnapshot: peer(),
      },
    });
    expect(() => inspectPiSessionFile(serialize([
      header,
      {
        ...base,
        type: "custom_message",
        customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
        content: foreignMessage.content,
        display: foreignMessage.display,
        details: foreignMessage.details,
      },
    ]), "foreign-message.jsonl")).toThrow(
      /message target.*current conversation/i,
    );

    const foreignReceipt = createMessageDeliveryReceiptEntry({
      messageId: randomUUID(),
      cardId: randomUUID(),
      fromConversationId: randomUUID(),
      toConversationId: randomUUID(),
      sourceRunId: randomUUID(),
      targetRunId: randomUUID(),
      kind: "message",
      sentAt: timestamp,
      payloadFingerprint: "a".repeat(64),
      deliveredAt: timestamp,
    });
    expect(() => inspectPiSessionFile(serialize([
      header,
      {
        ...base,
        type: "custom",
        customType: MESSAGE_DELIVERY_RECEIPT_CUSTOM_TYPE,
        data: foreignReceipt.data,
      },
    ]), "foreign-receipt.jsonl")).toThrow(
      /receipt target.*current conversation/i,
    );
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
