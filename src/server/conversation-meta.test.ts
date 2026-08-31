import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  COMPACTION_THRESHOLD_CUSTOM_TYPE,
  CONVERSATION_CARD_CUSTOM_TYPE,
  CONVERSATION_MESSAGE_CUSTOM_TYPE,
  CONVERSATION_META_CUSTOM_TYPE,
  CONVERSATION_ROLE_CHANGE_CUSTOM_TYPE,
  MAX_CONVERSATION_BODY_BYTES,
  MAX_CONVERSATION_MESSAGE_CONTENT_BYTES,
  MAX_ROLE_SYSTEM_PROMPT_BYTES,
  MAX_RUN_FINAL_TEXT_BYTES,
  LEGACY_LOOP_LIST_CUSTOM_TYPE,
  LEGACY_LOOP_LIST_CONTINUE_CUSTOM_TYPE,
  LOOP_LIST_CUSTOM_TYPE,
  LOOP_LIST_CONTINUE_CUSTOM_TYPE,
  META_OPERATION_CUSTOM_TYPE,
  PENDING_PROMPT_BATCH_CUSTOM_TYPE,
  PENDING_PROMPT_DELIVERY_CUSTOM_TYPE,
  RUN_SETTLEMENT_CUSTOM_TYPE,
  SERVICE_TIER_CUSTOM_TYPE,
  TEMPORARY_RETURN_RECEIPT_CUSTOM_TYPE,
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createCompactionThresholdEntry,
  createConversationCardEntry,
  createConversationMessageEntry,
  createConversationMetaEntry,
  createConversationRoleChangeEntry,
  createMetaOperationEntry,
  createRunSettlementEntry,
  createServiceTierSelectionEntry,
  createLoopListEntry,
  createLoopListContinueEntry,
  createTemporaryReturnReceiptEntry,
  parseConversationCardEntry,
  parseCompactionThresholdEntry,
  parseConversationMessageEntry,
  parseConversationMetaEntry,
  parseConversationRoleChangeEntry,
  parseMetaOperationEntry,
  parsePendingPromptBatchEntry,
  parseLoopListEntry,
  parseLoopListContinueEntry,
  parsePendingPromptDeliveryEntry,
  parseReservedConversationEntry,
  parseRunSettlementEntry,
  parseServiceTierSelectionEntry,
  parseTemporaryReturnReceiptEntry,
} from "./conversation-meta.js";
import type {
  PendingPromptBatch,
  PendingPromptBatchEntry,
  PendingPromptDelivery,
  PendingPromptDeliveryEntry,
} from "./conversation-meta.js";

const timestamp = "2026-07-19T10:00:00.000Z";

function deliveryEntry(data: PendingPromptDelivery): PendingPromptDeliveryEntry {
  return parsePendingPromptDeliveryEntry({
    customType: PENDING_PROMPT_DELIVERY_CUSTOM_TYPE,
    data,
  });
}

function batchEntry(data: PendingPromptBatch): PendingPromptBatchEntry {
  return parsePendingPromptBatchEntry({
    customType: PENDING_PROMPT_BATCH_CUSTOM_TYPE,
    data,
  });
}


function peer(conversationId = randomUUID()) {
  return {
    conversationId,
    title: "Parser worker",
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
      revision: 3,
      name: "Worker",
      description: "Builds focused changes",
      systemPrompt: "Keep changes small.",
      model: {
        provider: "openai",
        id: "gpt-5.6",
      },
      defaultThinkingLevel: "high" as const,
      defaultServiceTier: null,
      toolMode: "read_only" as const,
      canManageSessions: true,
    },
    lifecycle: {
      kind: "temporary" as const,
      callerConversationId: randomUUID(),
      delegationId: randomUUID(),
      returnMessageId: randomUUID(),
      initialRunId: randomUUID(),
    },
    createdBy: {
      kind: "conversation" as const,
      conversationId: randomUUID(),
    },
  };
}

function card() {
  return {
    cardId: randomUUID(),
    kind: "delegation_task" as const,
    body: "Implement the parser",
    fromSnapshot: peer(),
    toSnapshot: peer(),
    state: "sending" as const,
    messageId: randomUUID(),
    delegationId: randomUUID(),
    updatedAt: timestamp,
  };
}

function message() {
  return {
    content: "Message from Parser worker (Worker):\n\nImplement the parser",
    display: true as const,
    details: {
      messageId: randomUUID(),
      cardId: randomUUID(),
      sentAt: timestamp,
      kind: "message" as const,
      body: "Implement the parser",
      fromSnapshot: peer(),
      toSnapshot: peer(),
      replyToMessageId: randomUUID(),
      delegationId: randomUUID(),
    },
  };
}

function settlement() {
  return {
    runId: randomUUID(),
    outcome: "completed" as const,
    finalText: "Parser complete.",
    settledAt: timestamp,
  };
}

function startedOperation() {
  return {
    operationId: randomUUID(),
    kind: "delete_session" as const,
    targetConversationId: randomUUID(),
    state: "started" as const,
    updatedAt: timestamp,
  };
}

function startedAbortOperation() {
  return {
    operationId: randomUUID(),
    kind: "abort_session" as const,
    targetConversationId: randomUUID(),
    runId: randomUUID(),
    result: { aborted: true as const },
    state: "started" as const,
    updatedAt: timestamp,
  };
}

describe("conversation reserved entries", () => {
  it("constructs strict immutable conversation role metadata", () => {
    const value = metadata();
    const entry = createConversationMetaEntry(value);

    expect(entry).toEqual({
      customType: CONVERSATION_META_CUSTOM_TYPE,
      data: value,
    });
    value.role.name = "mutated";
    expect(entry.data.role.name).toBe("Worker");
    expect(parseConversationMetaEntry(entry)).toEqual(entry);
  });

  it("keeps the latest valid conversation compaction threshold", () => {
    const initial = createCompactionThresholdEntry({
      percent: 70,
      updatedAt: timestamp,
    });
    const changed = createCompactionThresholdEntry({
      percent: 55,
      updatedAt: "2026-07-19T10:01:00.000Z",
    });

    expect(initial.customType).toBe(COMPACTION_THRESHOLD_CUSTOM_TYPE);
    expect(parseCompactionThresholdEntry(initial)).toEqual(initial);
    expect(aggregateReservedConversationEntries([
      initial,
      changed,
    ]).compactionThreshold).toEqual(changed.data);
    expect(() => createCompactionThresholdEntry({
      percent: 19,
      updatedAt: timestamp,
    })).toThrow(/percent/i);
    expect(() => createCompactionThresholdEntry({
      percent: 91,
      updatedAt: timestamp,
    })).toThrow(/percent/i);
    expect(() => aggregateReservedConversationEntries([
      changed,
      initial,
    ])).toThrow(/updatedAt cannot regress/i);
  });

  it("keeps the latest strict service tier selection", () => {
    const initial = createServiceTierSelectionEntry({
      tier: "priority",
      updatedAt: timestamp,
    });
    const cleared = createServiceTierSelectionEntry({
      tier: null,
      updatedAt: "2026-07-19T10:01:00.000Z",
    });

    expect(initial.customType).toBe(SERVICE_TIER_CUSTOM_TYPE);
    expect(parseServiceTierSelectionEntry(initial)).toEqual(initial);
    expect(aggregateReservedConversationEntries([
      initial,
      cleared,
    ]).serviceTier).toEqual(cleared.data);
    expect(() => parseServiceTierSelectionEntry({
      ...initial,
      data: { ...initial.data, tier: "unknown" },
    })).toThrow(/tier/i);
    expect(() => aggregateReservedConversationEntries([
      cleared,
      initial,
    ])).toThrow(/service tier updatedAt cannot regress/i);
  });

  it("migrates v1 LoopList entries and round-trips strict v2 snapshots", () => {
    const legacyItems = [
      { id: "implement", text: "Implement LoopList", checked: false },
      { id: "record", text: "Record result", checked: true },
    ];
    const legacy = {
      customType: LEGACY_LOOP_LIST_CUSTOM_TYPE,
      data: {
        items: legacyItems,
        armed: true,
        updatedAt: "2026-07-19T09:59:00.000Z",
      },
    };
    const legacyContinuation = {
      customType: LEGACY_LOOP_LIST_CONTINUE_CUSTOM_TYPE,
      content: [
        "Current LoopList snapshot:",
        "[ ] Implement LoopList (implement)",
        "[x] Record result (record)",
        "Continue working through the unchecked items. Update the list with todo_write as progress changes.",
      ].join("\n"),
      display: false,
      details: {
        runId: randomUUID(),
        continuation: 1,
        items: legacyItems,
      },
    };
    const migrated = {
      items: [
        { id: "implement", text: "Implement LoopList", status: "pending" },
        { id: "record", text: "Record result", status: "completed" },
      ],
      armed: true,
      updatedAt: "2026-07-19T09:59:00.000Z",
    };
    const parsedLegacy = parseReservedConversationEntry(legacy);
    const parsedLegacyContinuation = parseReservedConversationEntry(
      legacyContinuation,
    );
    expect(parsedLegacy).toMatchObject({ kind: "loop_list" });
    expect(parsedLegacyContinuation).toMatchObject({
      kind: "loop_list_continue",
    });
    if (parsedLegacy?.kind !== "loop_list") {
      throw new Error("Expected a legacy LoopList entry");
    }
    if (parsedLegacyContinuation?.kind !== "loop_list_continue") {
      throw new Error("Expected a legacy LoopList continuation");
    }
    expect(parsedLegacy.entry.data).toEqual(migrated);
    expect(parsedLegacyContinuation.entry.details.items).toEqual(migrated.items);
    expect(parsedLegacy.entry.data.items)
      .not.toContainEqual(expect.objectContaining({ status: "active" }));

    const initial = createLoopListEntry({
      items: [{ id: "implement", text: "Implement LoopList", status: "active" }],
      armed: true,
      updatedAt: timestamp,
    });
    const completed = createLoopListEntry({
      items: [{ id: "implement", text: "Implement LoopList", status: "completed" }],
      armed: false,
      updatedAt: "2026-07-19T10:01:00.000Z",
    });
    const continuation = createLoopListContinueEntry({
      runId: randomUUID(),
      continuation: 1,
      items: initial.data.items,
    });

    expect(initial.customType).toBe(LOOP_LIST_CUSTOM_TYPE);
    expect(continuation).toMatchObject({
      customType: LOOP_LIST_CONTINUE_CUSTOM_TYPE,
      display: false,
    });
    expect(parseLoopListEntry(initial)).toEqual(initial);
    expect(parseLoopListContinueEntry(continuation)).toEqual(continuation);
    expect(aggregateReservedConversationEntries([
      legacy,
      legacyContinuation,
      initial,
      continuation,
      completed,
    ]).loopList).toEqual(completed.data);

    expect(() => parseLoopListEntry({
      ...initial,
      data: {
        ...initial.data,
        items: [...initial.data.items, initial.data.items[0]],
      },
    })).toThrow(/unique/i);
    expect(() => parseLoopListEntry({
      ...initial,
      data: {
        ...initial.data,
        items: [{ id: "implement", text: "Legacy field", checked: false }],
      },
    })).toThrow();
    expect(() => parseLoopListContinueEntry({
      ...continuation,
      content: "tampered",
    })).toThrow(/must match/i);
    expect(() => aggregateReservedConversationEntries([
      completed,
      initial,
    ])).toThrow(/LoopList updatedAt cannot regress/i);
  });

  it("applies durable role changes after the base conversation metadata", () => {
    const initial = createConversationMetaEntry(metadata());
    const changed = createConversationRoleChangeEntry({
      role: {
        ...initial.data.role,
        revision: 4,
        name: "Builder",
        toolMode: "full_access",
      },
      selectedServiceTier: "priority",
      changedAt: "2026-07-19T10:01:00.000Z",
    });

    expect(changed.customType).toBe(CONVERSATION_ROLE_CHANGE_CUSTOM_TYPE);
    expect(parseConversationRoleChangeEntry(changed)).toEqual(changed);
    expect(aggregateReservedConversationEntries([
      initial,
      changed,
    ]).conversationMeta?.role).toEqual(changed.data.role);
    expect(aggregateReservedConversationEntries([
      initial,
      changed,
    ]).serviceTier).toEqual({
      tier: "priority",
      updatedAt: changed.data.changedAt,
    });
    expect(() => aggregateReservedConversationEntries([
      changed,
      initial,
    ])).toThrow(/before conversation metadata/i);
  });

  it("preserves the conversation tier for legacy role changes and applies explicit null", () => {
    const initial = createConversationMetaEntry(metadata());
    const selected = createServiceTierSelectionEntry({
      tier: "priority",
      updatedAt: timestamp,
    });
    const legacyChange = parseConversationRoleChangeEntry({
      customType: CONVERSATION_ROLE_CHANGE_CUSTOM_TYPE,
      data: {
        role: { ...initial.data.role, revision: 4 },
        changedAt: "2026-07-19T10:01:00.000Z",
      },
    });
    const cleared = createConversationRoleChangeEntry({
      role: { ...initial.data.role, revision: 5 },
      selectedServiceTier: null,
      changedAt: "2026-07-19T10:02:00.000Z",
    });

    expect(aggregateReservedConversationEntries([
      initial,
      selected,
      legacyChange,
    ]).serviceTier).toEqual(selected.data);
    expect(aggregateReservedConversationEntries([
      initial,
      selected,
      legacyChange,
      cleared,
    ]).serviceTier).toEqual({
      tier: null,
      updatedAt: cleared.data.changedAt,
    });
  });

  it("keeps legacy conversation behavior closed", () => {
    const value = metadata();
    const {
      canManageSessions: _omittedCapability,
      defaultThinkingLevel: _omittedThinkingLevel,
      defaultServiceTier: _omittedServiceTier,
      ...legacyRole
    } = value.role;

    const parsed = parseConversationMetaEntry({
      customType: CONVERSATION_META_CUSTOM_TYPE,
      data: { ...value, role: legacyRole },
    });
    expect(parsed.data.role.canManageSessions).toBe(false);
    expect(parsed.data.role.defaultThinkingLevel).toBe("off");
    expect(parsed.data.role.defaultServiceTier).toBeNull();
  });

  it("rejects unknown, incomplete, and over-limit conversation metadata", () => {
    const valid = createConversationMetaEntry(metadata());

    expect(() => parseConversationMetaEntry({
      ...valid,
      surprise: true,
    })).toThrow(/unknown|unrecognized/i);
    expect(() => parseConversationMetaEntry({
      ...valid,
      data: {
        ...valid.data,
        lifecycle: {
          kind: "temporary",
          callerConversationId: randomUUID(),
          delegationId: randomUUID(),
          returnMessageId: randomUUID(),
        },
      },
    })).toThrow(/initialRunId/i);
    expect(() => createConversationMetaEntry({
      ...metadata(),
      role: {
        ...metadata().role,
        systemPrompt: "界".repeat(
          Math.floor(MAX_ROLE_SYSTEM_PROMPT_BYTES / 3) + 1,
        ),
      },
    })).toThrow(/systemPrompt/i);
    expect(() => createConversationMetaEntry({
      ...metadata(),
      role: {
        ...metadata().role,
        revision: 0,
      },
    })).toThrow(/revision/i);
  });

  it("accepts optional orchestration fields and rejects invalid values", () => {
    const base = metadata();

    // Absent orchestration is valid (legacy metadata).
    const withoutOrchestration = createConversationMetaEntry(base);
    expect(parseConversationMetaEntry(withoutOrchestration)).toEqual(
      withoutOrchestration,
    );

    // Valid orchestration round-trips.
    const orchestration = {
      rootConversationId: randomUUID(),
      depth: 0,
    };
    const withOrchestration = createConversationMetaEntry({
      ...base,
      orchestration,
    });
    expect(parseConversationMetaEntry(withOrchestration)).toEqual(
      withOrchestration,
    );

    // Valid orchestration with optional sourceRunId.
    const withRunId = createConversationMetaEntry({
      ...base,
      orchestration: {
        ...orchestration,
        sourceRunId: randomUUID(),
      },
    });
    expect(parseConversationMetaEntry(withRunId)).toEqual(withRunId);

    // Negative depth is rejected.
    expect(() => createConversationMetaEntry({
      ...base,
      orchestration: { rootConversationId: randomUUID(), depth: -1 },
    })).toThrow(/depth/i);

    // Non-integer depth is rejected.
    expect(() => createConversationMetaEntry({
      ...base,
      orchestration: { rootConversationId: randomUUID(), depth: 0.5 },
    })).toThrow(/depth/i);

    // Non-UUID sourceRunId is rejected.
    expect(() => createConversationMetaEntry({
      ...base,
      orchestration: {
        rootConversationId: randomUUID(),
        depth: 0,
        sourceRunId: "not-a-uuid",
      },
    })).toThrow(/sourceRunId/i);

    // Extra unknown key inside orchestration is rejected (strict).
    const withExtra = {
      customType: withoutOrchestration.customType,
      data: {
        ...withoutOrchestration.data,
        orchestration: {
          rootConversationId: randomUUID(),
          depth: 0,
          extra: true,
        },
      },
    };
    expect(() => parseConversationMetaEntry(withExtra))
      .toThrow(/unknown|unrecognized/i);
  });

  it("round-trips strict card updates and bounds their semantic body", () => {
    const entry = createConversationCardEntry(card());

    expect(entry.customType).toBe(CONVERSATION_CARD_CUSTOM_TYPE);
    expect(parseConversationCardEntry(entry)).toEqual(entry);
    expect(() => parseConversationCardEntry({
      ...entry,
      data: {
        ...entry.data,
        state: "unknown",
      },
    })).toThrow(/state/i);
    expect(() => parseConversationCardEntry({
      ...entry,
      data: {
        ...entry.data,
        toSnapshot: {
          ...entry.data.toSnapshot,
          extra: true,
        },
      },
    })).toThrow(/unknown|unrecognized/i);
    expect(() => createConversationCardEntry({
      ...card(),
      body: "x".repeat(MAX_CONVERSATION_BODY_BYTES + 1),
    })).toThrow(/body/i);
    expect(() => createConversationCardEntry({
      ...card(),
      result: "not settled",
    })).toThrow(/result/i);
    expect(createConversationCardEntry({
      ...card(),
      state: "completed",
      result: "Parser complete.",
      requestFingerprint: "a".repeat(64),
    }).data.result).toBe("Parser complete.");
    expect(() => createConversationCardEntry({
      ...card(),
      requestFingerprint: "A".repeat(64),
    })).toThrow(/requestFingerprint/i);
    expect(() => createConversationCardEntry({
      ...card(),
      requestFingerprint: "a".repeat(63),
    })).toThrow(/requestFingerprint/i);
  });

  it("constructs custom messages whose details are strict and content is bounded", () => {
    const entry = createConversationMessageEntry(message());

    expect(entry.customType).toBe(CONVERSATION_MESSAGE_CUSTOM_TYPE);
    expect(parseConversationMessageEntry(entry)).toEqual(entry);
    expect(() => parseConversationMessageEntry({
      ...entry,
      display: false,
    })).toThrow(/display/i);
    expect(() => parseConversationMessageEntry({
      ...entry,
      details: {
        ...entry.details,
        unknown: true,
      },
    })).toThrow(/unknown|unrecognized/i);
    expect(() => createConversationMessageEntry({
      ...message(),
      details: {
        ...message().details,
        body: "界".repeat(
          Math.floor(MAX_CONVERSATION_BODY_BYTES / 3) + 1,
        ),
      },
    })).toThrow(/body/i);
    expect(() => createConversationMessageEntry({
      ...message(),
      content: "x".repeat(
        MAX_CONVERSATION_MESSAGE_CONTENT_BYTES + 1,
      ),
    })).toThrow(/content/i);
  });

  it("records exact run settlements and requires complete report identity", () => {
    const pending = createRunSettlementEntry(settlement());
    const reported = createRunSettlementEntry({
      ...settlement(),
      reportedAt: "2026-07-19T10:01:00.000Z",
      returnMessageId: randomUUID(),
    });

    expect(pending.customType).toBe(RUN_SETTLEMENT_CUSTOM_TYPE);
    expect(parseRunSettlementEntry(pending)).toEqual(pending);
    expect(parseRunSettlementEntry(reported)).toEqual(reported);
    expect(() => createRunSettlementEntry({
      ...settlement(),
      reportedAt: "2026-07-19T10:01:00.000Z",
    })).toThrow(/returnMessageId/i);
    expect(() => createRunSettlementEntry({
      ...settlement(),
      finalText: Number.NaN,
    })).toThrow(/finalText/i);
    expect(() => createRunSettlementEntry({
      ...settlement(),
      settledAt: "not-a-date",
    })).toThrow(/settledAt/i);
    expect(() => createRunSettlementEntry({
      ...settlement(),
      finalText: "x".repeat(MAX_RUN_FINAL_TEXT_BYTES + 1),
    })).toThrow(/finalText/i);
  });

  it("records pending prompt delivery receipts by prompt identity, allowing one run to deliver several prompts", () => {
    const delivery = deliveryEntry({
      promptId: randomUUID(),
      runId: randomUUID(),
      deliveredAt: timestamp,
    });
    const batchDelivery = deliveryEntry({
      promptId: randomUUID(),
      runId: delivery.data.runId,
      batchId: randomUUID(),
      deliveredAt: "2026-07-19T10:00:30.000Z",
    });
    const sameRunDifferentPrompt = deliveryEntry({
      promptId: randomUUID(),
      runId: delivery.data.runId,
      deliveredAt: "2026-07-19T10:01:00.000Z",
    });
    expect(delivery.customType).toBe(PENDING_PROMPT_DELIVERY_CUSTOM_TYPE);
    expect(parsePendingPromptDeliveryEntry(delivery)).toEqual(delivery);
    expect(delivery.data.batchId).toBeUndefined();
    expect(parsePendingPromptDeliveryEntry(batchDelivery)).toEqual(batchDelivery);
    expect(parseReservedConversationEntry(delivery)).toEqual({
      kind: "pending_prompt_delivery",
      entry: delivery,
    });
    expect(aggregateReservedConversationEntries([delivery, delivery])
      .pendingPromptDeliveries).toEqual([delivery.data]);
    expect(aggregateReservedConversationEntries([
      delivery,
      batchDelivery,
      sameRunDifferentPrompt,
    ]).pendingPromptDeliveries).toEqual([
      delivery.data,
      batchDelivery.data,
      sameRunDifferentPrompt.data,
    ]);
    expect(() => aggregateReservedConversationEntries([
      delivery,
      deliveryEntry({
        ...delivery.data,
        deliveredAt: "2026-07-19T10:01:00.000Z",
      }),
    ])).toThrow(/conflicting.*pending prompt delivery/i);
    expect(() => aggregateReservedConversationEntries([
      delivery,
      deliveryEntry({
        ...delivery.data,
        runId: randomUUID(),
      }),
    ])).toThrow(/conflicting.*pending prompt delivery/i);
    expect(() => deliveryEntry({
      ...delivery.data,
      promptId: "not-a-uuid",
    })).toThrow(/promptId/i);
  });

  it("folds immutable pending prompt batch manifests through strict state transitions", () => {
    const prepared = batchEntry({
      batchId: randomUUID(),
      conversationId: randomUUID(),
      runId: randomUUID(),
      items: [
        {
          promptId: randomUUID(),
          createdAt: timestamp,
          payloadSha256: "a".repeat(64),
        },
        {
          promptId: randomUUID(),
          createdAt: "2026-07-19T10:00:01.000Z",
          payloadSha256: "b".repeat(64),
        },
      ],
      state: "prepared",
      updatedAt: timestamp,
    });
    const started = batchEntry({
      ...prepared.data,
      state: "started",
      updatedAt: "2026-07-19T10:01:00.000Z",
    });
    const delivered = batchEntry({
      ...started.data,
      state: "delivered",
      updatedAt: "2026-07-19T10:02:00.000Z",
    });
    const completed = batchEntry({
      ...delivered.data,
      state: "completed",
      updatedAt: "2026-07-19T10:03:00.000Z",
    });
    const preparedAttention = batchEntry({
      ...prepared.data,
      state: "attention",
      reason: "sidecar disappeared during recovery",
      updatedAt: "2026-07-19T10:04:00.000Z",
    });
    const deliveredAttention = batchEntry({
      ...delivered.data,
      state: "attention",
      reason: "delivery proof was lost",
      updatedAt: "2026-07-19T10:04:00.000Z",
    });

    expect(prepared.customType).toBe(PENDING_PROMPT_BATCH_CUSTOM_TYPE);
    expect(parsePendingPromptBatchEntry(prepared)).toEqual(prepared);
    expect(parseReservedConversationEntry(prepared)).toEqual({
      kind: "pending_prompt_batch",
      entry: prepared,
    });
    expect(aggregateReservedConversationEntries([
      prepared,
      prepared,
      started,
      delivered,
      completed,
      completed,
    ]).pendingPromptBatches).toEqual([completed.data]);
    expect(aggregateReservedConversationEntries([
      prepared,
      preparedAttention,
    ]).pendingPromptBatches).toEqual([preparedAttention.data]);
    expect(aggregateReservedConversationEntries([
      prepared,
      started,
      delivered,
      deliveredAttention,
    ]).pendingPromptBatches).toEqual([deliveredAttention.data]);
    expect(() => aggregateReservedConversationEntries([started]))
      .toThrow(/begin in prepared/i);
    expect(() => aggregateReservedConversationEntries([
      prepared,
      delivered,
    ])).toThrow(/cannot transition/i);
    expect(() => aggregateReservedConversationEntries([
      prepared,
      batchEntry({
        ...started.data,
        runId: randomUUID(),
      }),
    ])).toThrow(/conflicting.*identity/i);
    expect(() => aggregateReservedConversationEntries([
      prepared,
      started,
      batchEntry({
        ...started.data,
        state: "failed",
        updatedAt: "2026-07-19T10:02:00.000Z",
        reason: "deterministic rejection",
      }),
      batchEntry({
        ...started.data,
        updatedAt: "2026-07-19T10:03:00.000Z",
      }),
    ])).toThrow(/terminal state/i);
    expect(() => parsePendingPromptBatchEntry({
      customType: PENDING_PROMPT_BATCH_CUSTOM_TYPE,
      data: {
        ...prepared.data,
        items: [{
          ...prepared.data.items[0],
          payloadSha256: "A".repeat(64),
        }],
        reason: "forbidden",
      },
    })).toThrow(/unrecognized|unknown/i);
    expect(() => parsePendingPromptBatchEntry({
      customType: PENDING_PROMPT_BATCH_CUSTOM_TYPE,
      data: {
        ...prepared.data,
        items: [{
          ...prepared.data.items[0],
          payloadSha256: "A".repeat(64),
        }],
      },
    })).toThrow(/payloadSha256/i);
    expect(() => parsePendingPromptBatchEntry({
      customType: PENDING_PROMPT_BATCH_CUSTOM_TYPE,
      data: {
        ...prepared.data,
        state: "failed",
      },
    })).toThrow(/reason/i);
  });

  it("records caller-owned temporary return receipt transitions strictly", () => {
    const temporaryConversationId = randomUUID();
    const initialRunId = randomUUID();
    const messageId = randomUUID();
    const delegation = createConversationCardEntry({
      ...card(),
      kind: "delegation_task",
      toSnapshot: peer(temporaryConversationId),
      runId: initialRunId,
      state: "running",
    });
    const claimed = createTemporaryReturnReceiptEntry({
      temporaryConversationId,
      initialRunId,
      messageId,
      callerRunId: randomUUID(),
      claimedAt: timestamp,
      state: "claimed",
    });
    const reported = createRunSettlementEntry({
      runId: initialRunId,
      outcome: "completed",
      finalText: "final answer",
      settledAt: timestamp,
      reportedAt: "2026-07-19T10:01:00.000Z",
      returnMessageId: messageId,
    }).data;
    const settled = createTemporaryReturnReceiptEntry({
      ...claimed.data,
      state: "settled",
      settlement: reported,
    });

    expect(claimed.customType).toBe(TEMPORARY_RETURN_RECEIPT_CUSTOM_TYPE);
    expect(parseTemporaryReturnReceiptEntry(claimed)).toEqual(claimed);
    expect(parseReservedConversationEntry(claimed)).toEqual({
      kind: "temporary_return_receipt",
      entry: claimed,
    });
    expect(aggregateReservedConversationEntries([
      delegation,
      claimed,
      claimed,
      settled,
      settled,
    ]).temporaryReturnReceipts).toEqual([settled.data]);
    expect(() => createTemporaryReturnReceiptEntry({
      ...claimed.data,
      callerRunId: "not-a-uuid",
    })).toThrow(/callerRunId/i);
    expect(() => parseTemporaryReturnReceiptEntry({
      ...claimed,
      data: { ...claimed.data, extra: true },
    })).toThrow(/unknown|unrecognized/i);
    expect(() => createTemporaryReturnReceiptEntry({
      ...settled.data,
      settlement: { ...reported, runId: randomUUID() },
    })).toThrow(/initial run/i);
    expect(() => createTemporaryReturnReceiptEntry({
      ...settled.data,
      settlement: { ...reported, returnMessageId: randomUUID() },
    })).toThrow(/messageId/i);
    for (const settlement of [
      { ...reported, outcome: "failed" as const },
      { ...reported, outcome: "aborted" as const },
      { ...reported, finalText: null },
      { ...reported, finalText: "   " },
      {
        ...reported,
        finalText: "x".repeat(MAX_CONVERSATION_BODY_BYTES + 1),
      },
    ]) {
      expect(() => createTemporaryReturnReceiptEntry({
        ...settled.data,
        settlement,
      })).toThrow(/returnable/i);
    }
    expect(() => aggregateReservedConversationEntries([
      claimed,
    ])).toThrow(/requires an earlier initial delegation card/i);
    expect(() => aggregateReservedConversationEntries([
      delegation,
      settled,
    ])).toThrow(/must begin in claimed state/i);
    expect(() => aggregateReservedConversationEntries([
      delegation,
      claimed,
      createTemporaryReturnReceiptEntry({
        ...claimed.data,
        messageId: randomUUID(),
      }),
    ])).toThrow(/conflicting.*temporary return receipt/i);
    expect(() => aggregateReservedConversationEntries([
      delegation,
      claimed,
      settled,
      claimed,
    ])).toThrow(/state cannot regress/i);
  });

  it("records strict delete-session operation states", () => {
    const started = createMetaOperationEntry(startedOperation());
    const completed = createMetaOperationEntry({
      ...started.data,
      state: "completed",
      deleted: true,
      updatedAt: "2026-07-19T10:01:00.000Z",
    });

    expect(started.customType).toBe(META_OPERATION_CUSTOM_TYPE);
    expect(parseMetaOperationEntry(started)).toEqual(started);
    expect(parseMetaOperationEntry(completed)).toEqual(completed);
    expect(() => parseMetaOperationEntry({
      ...started,
      data: {
        ...started.data,
        surprise: true,
      },
    })).toThrow(/unknown|unrecognized/i);
    expect(() => parseMetaOperationEntry({
      ...started,
      data: {
        ...started.data,
        kind: "future_operation",
      },
    })).toThrow(/kind/i);
    expect(() => parseMetaOperationEntry({
      ...started,
      data: {
        ...started.data,
        operationId: started.data.operationId.toUpperCase(),
      },
    })).toThrow(/canonical UUID/i);
    expect(() => parseMetaOperationEntry({
      ...started,
      data: {
        ...started.data,
        updatedAt: "2026-07-19 10:00:00Z",
      },
    })).toThrow(/canonical ISO timestamp/i);
    expect(() => parseMetaOperationEntry({
      ...started,
      data: {
        ...started.data,
        state: "completed",
      },
    })).toThrow(/deleted/i);
  });

  it("records the exact abort-session identity and decided result", () => {
    const started = createMetaOperationEntry(startedAbortOperation());
    const completed = createMetaOperationEntry({
      ...started.data,
      state: "completed",
      updatedAt: "2026-07-19T10:01:00.000Z",
    });
    const inactive = createMetaOperationEntry({
      ...startedAbortOperation(),
      result: {
        aborted: false,
        reason: "run_not_active",
      },
    });

    expect(parseMetaOperationEntry(started)).toEqual(started);
    expect(parseMetaOperationEntry(completed)).toEqual(completed);
    expect(parseMetaOperationEntry(inactive)).toEqual(inactive);
    expect(() => createMetaOperationEntry({
      ...started.data,
      result: {
        aborted: false,
      },
    } as never)).toThrow(/reason|union/i);
    expect(() => createMetaOperationEntry({
      ...started.data,
      result: {
        aborted: true,
        reason: "run_not_active",
      },
    } as never)).toThrow(/unknown|unrecognized|union/i);
  });

  it("routes only known piweb reserved custom types", () => {
    const meta = createConversationMetaEntry(metadata());
    const cardEntry = createConversationCardEntry(card());
    const messageEntry = createConversationMessageEntry(message());
    const run = createRunSettlementEntry(settlement());
    const operation = createMetaOperationEntry(startedOperation());

    expect(parseReservedConversationEntry(meta)).toEqual({
      kind: "conversation_meta",
      entry: meta,
    });
    expect(parseReservedConversationEntry(cardEntry)).toEqual({
      kind: "conversation_card",
      entry: cardEntry,
    });
    expect(parseReservedConversationEntry(messageEntry)).toEqual({
      kind: "conversation_message",
      entry: messageEntry,
    });
    expect(parseReservedConversationEntry(run)).toEqual({
      kind: "run_settlement",
      entry: run,
    });
    expect(parseReservedConversationEntry(operation)).toEqual({
      kind: "meta_operation",
      entry: operation,
    });
    const resume = {
      customType: "piweb.compaction_resume.v1",
      content:
        "Continue the unfinished task from the retained context.",
      display: false,
      details: { runId: randomUUID() },
    };
    expect(parseReservedConversationEntry(resume)).toEqual({
      kind: "compaction_resume",
      entry: resume,
    });
    expect(aggregateReservedConversationEntries([
      resume,
    ])).toMatchObject({
      deliveredMessageIds: [],
      runSettlements: [],
    });
    expect(parseReservedConversationEntry({
      customType: "extension.state",
      data: {},
    })).toBeUndefined();
    expect(() => parseReservedConversationEntry({
      customType: "piweb.future.v2",
      data: {},
    })).toThrow(/unknown piweb reserved/i);
  });

  it("parses real Pi carriers and locks custom versus custom_message context semantics", () => {
    const manager = SessionManager.inMemory();
    const meta = createConversationMetaEntry(metadata());
    const metaId = appendReservedCustomEntry(manager, meta);
    meta.data.role.name = "mutated after append";

    expect(manager.buildSessionContext().messages).toEqual([]);
    const storedMeta = manager.getEntry(metaId);
    expect(storedMeta).toMatchObject({
      type: "custom",
      customType: CONVERSATION_META_CUSTOM_TYPE,
      data: {
        role: { name: "Worker" },
      },
    });
    expect(parseReservedConversationEntry(storedMeta)).toEqual({
      kind: "conversation_meta",
      entry: expect.objectContaining({
        customType: CONVERSATION_META_CUSTOM_TYPE,
      }),
    });

    const incoming = createConversationMessageEntry(message());
    const incomingId = manager.appendCustomMessageEntry(
      incoming.customType,
      incoming.content,
      incoming.display,
      incoming.details,
    );
    expect(parseReservedConversationEntry(
      manager.getEntry(incomingId),
    )).toEqual({
      kind: "conversation_message",
      entry: incoming,
    });
    expect(manager.buildSessionContext().messages).toEqual([
      expect.objectContaining({
        role: "custom",
        customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
        content: incoming.content,
        details: incoming.details,
      }),
    ]);

    const contextBeforeHostState = structuredClone(
      manager.buildSessionContext().messages,
    );
    const card = createConversationCardEntry({
      cardId: randomUUID(),
      kind: "message",
      body: "Inspect the stable prefix",
      fromSnapshot: peer(),
      toSnapshot: peer(),
      state: "queued",
      messageId: randomUUID(),
      updatedAt: timestamp,
    });
    appendReservedCustomEntry(manager, card);
    appendReservedCustomEntry(manager, createConversationCardEntry({
      ...card.data,
      state: "completed",
      result: "done",
      updatedAt: "2026-07-19T10:01:00.000Z",
    }));
    appendReservedCustomEntry(manager, createRunSettlementEntry({
      runId: randomUUID(),
      outcome: "completed",
      finalText: "done",
      settledAt: "2026-07-19T10:02:00.000Z",
    }));
    expect(manager.buildSessionContext().messages).toEqual(
      contextBeforeHostState,
    );
  });

  it("accepts Pi legacy conversation IDs but rejects a reserved nested custom carrier", () => {
    const value = metadata();
    value.lifecycle.callerConversationId = "legacy.session_1";
    value.createdBy.conversationId = "legacy-session";
    expect(createConversationMetaEntry(value)).toBeDefined();

    expect(() => parseReservedConversationEntry({
      type: "message",
      message: {
        role: "custom",
        customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
      },
    })).toThrow(/nested message\.role=custom/i);
  });

  it("aggregates physical entries with strict identity and monotonic settlement rules", () => {
    const meta = createConversationMetaEntry(metadata());
    const firstCard = createConversationCardEntry(card());
    const finalCard = createConversationCardEntry({
      ...firstCard.data,
      state: "completed",
      updatedAt: "2026-07-19T10:02:00.000Z",
    });
    const incoming = createConversationMessageEntry(message());
    const pending = createRunSettlementEntry(settlement());
    const reported = createRunSettlementEntry({
      ...pending.data,
      reportedAt: "2026-07-19T10:03:00.000Z",
      returnMessageId: randomUUID(),
    });
    const operationStarted = createMetaOperationEntry(
      startedOperation(),
    );
    const operationCompleted = createMetaOperationEntry({
      ...operationStarted.data,
      state: "completed",
      deleted: true,
      updatedAt: "2026-07-19T10:04:00.000Z",
    });

    const aggregate = aggregateReservedConversationEntries([
      meta,
      firstCard,
      incoming,
      pending,
      pending,
      finalCard,
      reported,
      operationStarted,
      operationCompleted,
      { customType: "extension.state", data: {} },
    ]);
    expect(aggregate.conversationMeta).toEqual(meta.data);
    expect(aggregate.cards).toEqual([finalCard.data]);
    expect(aggregate.deliveredMessageIds).toEqual([
      incoming.details.messageId,
    ]);
    expect(aggregate.runSettlements).toEqual([reported.data]);
    expect(aggregate.metaOperations).toEqual([
      operationCompleted.data,
    ]);

    expect(() => aggregateReservedConversationEntries([
      meta,
      meta,
    ])).toThrow(/duplicate.*metadata/i);
    expect(() => aggregateReservedConversationEntries([
      incoming,
      incoming,
    ])).toThrow(/duplicate.*messageId/i);
    expect(() => aggregateReservedConversationEntries([
      pending,
      createRunSettlementEntry({
        ...pending.data,
        finalText: "different",
      }),
    ])).toThrow(/conflicting.*settlement/i);
    expect(() => aggregateReservedConversationEntries([
      reported,
      pending,
    ])).toThrow(/cannot change or regress/i);
  });

  it("requires immutable card identity and monotonic lifecycle updates", () => {
    const runId = randomUUID();
    const initial = createConversationCardEntry({
      ...card(),
      requestFingerprint: "a".repeat(64),
      requestedRole: metadata().role,
      orchestration: {
        rootConversationId: randomUUID(),
        depth: 1,
        sourceRunId: runId,
      },
    });
    const queued = createConversationCardEntry({
      ...initial.data,
      state: "queued",
      updatedAt: "2026-07-19T10:01:00.000Z",
    });
    const running = createConversationCardEntry({
      ...queued.data,
      state: "running",
      runId,
      updatedAt: "2026-07-19T10:02:00.000Z",
    });
    const deliveredAfterRunning = createConversationCardEntry({
      ...running.data,
      state: "delivered",
      updatedAt: "2026-07-19T10:02:30.000Z",
    });
    const completed = createConversationCardEntry({
      ...deliveredAfterRunning.data,
      state: "completed",
      result: "Done",
      updatedAt: "2026-07-19T10:03:00.000Z",
    });
    const replayed = createConversationCardEntry({
      ...completed.data,
      updatedAt: "2026-07-19T10:04:00.000Z",
    });

    expect(aggregateReservedConversationEntries([
      initial,
      initial,
      queued,
      running,
      deliveredAfterRunning,
      completed,
      replayed,
    ]).cards).toEqual([replayed.data]);

    const identityMutations = [
      { kind: "message" as const },
      { body: "A different task" },
      { fromSnapshot: peer() },
      { toSnapshot: peer() },
      { messageId: randomUUID() },
      { delegationId: randomUUID() },
      { requestFingerprint: "b".repeat(64) },
      {
        requestedRole: {
          ...initial.data.requestedRole!,
          revision: initial.data.requestedRole!.revision + 1,
        },
      },
      {
        orchestration: {
          ...initial.data.orchestration!,
          depth: initial.data.orchestration!.depth + 1,
        },
      },
    ];
    for (const mutation of identityMutations) {
      expect(() => aggregateReservedConversationEntries([
        initial,
        createConversationCardEntry({
          ...initial.data,
          ...mutation,
          state: "queued",
          updatedAt: "2026-07-19T10:01:00.000Z",
        }),
      ])).toThrow(/card identity/i);
    }

    expect(() => aggregateReservedConversationEntries([
      queued,
      createConversationCardEntry({
        ...queued.data,
        state: "sending",
        updatedAt: "2026-07-19T10:02:00.000Z",
      }),
    ])).toThrow(/state cannot regress/i);
    expect(() => aggregateReservedConversationEntries([
      running,
      createConversationCardEntry({
        ...running.data,
        runId: undefined,
        updatedAt: "2026-07-19T10:03:00.000Z",
      }),
    ])).toThrow(/runId cannot change or disappear/i);
    expect(() => aggregateReservedConversationEntries([
      running,
      createConversationCardEntry({
        ...running.data,
        runId: randomUUID(),
        updatedAt: "2026-07-19T10:03:00.000Z",
      }),
    ])).toThrow(/runId cannot change or disappear/i);
    expect(() => aggregateReservedConversationEntries([
      completed,
      createConversationCardEntry({
        ...completed.data,
        state: "failed",
        updatedAt: "2026-07-19T10:04:00.000Z",
      }),
    ])).toThrow(/terminal outcome/i);
    expect(() => aggregateReservedConversationEntries([
      completed,
      createConversationCardEntry({
        ...completed.data,
        result: "A different result",
        updatedAt: "2026-07-19T10:04:00.000Z",
      }),
    ])).toThrow(/terminal result cannot change/i);
    expect(() => aggregateReservedConversationEntries([
      queued,
      createConversationCardEntry({
        ...queued.data,
        updatedAt: "2026-07-19T09:59:00.000Z",
      }),
    ])).toThrow(/updatedAt cannot regress/i);
  });

  it("requires monotonic, identity-stable meta operation ledgers", () => {
    const started = createMetaOperationEntry(startedOperation());
    const completed = createMetaOperationEntry({
      ...started.data,
      state: "completed",
      deleted: false,
      updatedAt: "2026-07-19T10:02:00.000Z",
    });

    expect(aggregateReservedConversationEntries([
      started,
      createMetaOperationEntry({
        ...started.data,
        updatedAt: "2026-07-19T10:01:00.000Z",
      }),
      completed,
      createMetaOperationEntry({
        ...completed.data,
        updatedAt: "2026-07-19T10:03:00.000Z",
      }),
    ]).metaOperations).toEqual([
      expect.objectContaining({
        operationId: started.data.operationId,
        state: "completed",
        deleted: false,
        updatedAt: "2026-07-19T10:03:00.000Z",
      }),
    ]);
    expect(() => aggregateReservedConversationEntries([
      completed,
    ])).toThrow(/completed without a started state/i);
    expect(() => aggregateReservedConversationEntries([
      started,
      createMetaOperationEntry({
        ...started.data,
        targetConversationId: randomUUID(),
      }),
    ])).toThrow(/conflicting.*identity/i);
    expect(() => aggregateReservedConversationEntries([
      started,
      completed,
      createMetaOperationEntry({
        ...started.data,
        updatedAt: "2026-07-19T10:03:00.000Z",
      }),
    ])).toThrow(/state cannot regress/i);
    expect(() => aggregateReservedConversationEntries([
      started,
      createMetaOperationEntry({
        ...completed.data,
        updatedAt: "2026-07-19T09:59:00.000Z",
      }),
    ])).toThrow(/updatedAt cannot regress/i);
    expect(() => aggregateReservedConversationEntries([
      started,
      completed,
      createMetaOperationEntry({
        ...completed.data,
        deleted: true,
        updatedAt: "2026-07-19T10:03:00.000Z",
      }),
    ])).toThrow(/conflicting.*result/i);
  });

  it("rejects abort operation replays that change run identity or result", () => {
    const started = createMetaOperationEntry(startedAbortOperation());
    const completed = createMetaOperationEntry({
      ...started.data,
      state: "completed",
      updatedAt: "2026-07-19T10:01:00.000Z",
    });

    expect(aggregateReservedConversationEntries([
      started,
      completed,
    ]).metaOperations).toEqual([completed.data]);
    expect(() => aggregateReservedConversationEntries([
      started,
      createMetaOperationEntry({
        ...started.data,
        runId: randomUUID(),
        updatedAt: "2026-07-19T10:01:00.000Z",
      }),
    ])).toThrow(/conflicting.*identity/i);
    expect(() => aggregateReservedConversationEntries([
      started,
      createMetaOperationEntry({
        ...started.data,
        result: {
          aborted: false,
          reason: "run_not_active",
        },
        updatedAt: "2026-07-19T10:01:00.000Z",
      }),
    ])).toThrow(/conflicting.*result/i);
  });
});
