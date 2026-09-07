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
  LOOP_LIST_CUSTOM_TYPE,
  LOOP_LIST_CONTINUE_CUSTOM_TYPE,
  MESSAGE_DELIVERY_RECEIPT_CUSTOM_TYPE,
  META_OPERATION_CUSTOM_TYPE,
  RUN_SETTLEMENT_CUSTOM_TYPE,
  SERVICE_TIER_CUSTOM_TYPE,
  WAIT_POLL_CUSTOM_TYPE,
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createCompactionThresholdEntry,
  createConversationCardEntry,
  createConversationMessageEntry,
  createEditBudgetEntry,
  createConversationMetaEntry,
  createConversationRoleChangeEntry,
  createMetaOperationEntry,
  createRunSettlementEntry,
  createServiceTierSelectionEntry,
  createWaitPollEntry,
  createLoopListEntry,
  createLoopListContinueEntry,
  createMessageDeliveryReceiptEntry,
  parseConversationCardEntry,
  parseCompactionThresholdEntry,
  parseEditBudgetEntry,
  parseConversationMessageEntry,
  parseConversationMetaEntry,
  parseConversationRoleChangeEntry,
  parseMetaOperationEntry,
  parseLoopListEntry,
  parseLoopListContinueEntry,
  parseMessageDeliveryReceiptEntry,
  parseReservedConversationEntry,
  parseRunSettlementEntry,
  parseServiceTierSelectionEntry,
  parseWaitPollEntry,
} from "./conversation-meta.js";
import type {
  MessageDeliveryReceipt,
} from "./conversation-meta.js";

const timestamp = "2026-07-19T10:00:00.000Z";


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
      compactionModel: null,
      defaultThinkingLevel: "high" as const,
      defaultServiceTier: null,
      toolMode: "read_only" as const,
      canManageSessions: true,
    },
    lifecycle: {
      kind: "normal" as const,
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

function deliveryReceipt(): MessageDeliveryReceipt {
  return {
    messageId: randomUUID(),
    cardId: randomUUID(),
    fromConversationId: randomUUID(),
    toConversationId: randomUUID(),
    sourceRunId: randomUUID(),
    targetRunId: randomUUID(),
    kind: "message",
    sentAt: timestamp,
    payloadFingerprint: "a".repeat(64),
    deliveredAt: "2026-07-19T10:01:00.000Z",
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

  it("keeps edit-budget grants and irreversible charges as reserved entries", () => {
    const runId = randomUUID();
    const grant = createEditBudgetEntry({
      kind: "grant",
      runId,
      fileCount: 1,
    });
    const charge = createEditBudgetEntry({
      kind: "charge",
      runId,
      pathKey: "/project/src/file.ts",
    });

    expect(parseEditBudgetEntry(grant)).toEqual(grant);
    expect(parseReservedConversationEntry(charge)).toEqual({
      kind: "edit_budget",
      entry: charge,
    });
    expect(aggregateReservedConversationEntries([grant, charge]))
      .toMatchObject({ editBudgetEvents: [grant.data, charge.data] });
    expect(() => aggregateReservedConversationEntries([charge])).toThrow(
      /exceeds the granted file count/i,
    );
    expect(() => createEditBudgetEntry({
      kind: "charge",
      runId,
      pathKey: "\0",
    })).toThrow(/pathKey/i);
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

  it("accepts only v2 LoopList snapshots and continuations", () => {
    expect(() => parseReservedConversationEntry({
      customType: "piweb.loop_list.v1",
      data: { items: [], armed: true, updatedAt: timestamp },
    })).toThrow(/unknown piweb reserved custom type/i);
    expect(() => parseReservedConversationEntry({
      customType: "piweb.loop_list_continue.v1",
      content: "legacy",
      display: false,
      details: { runId: randomUUID(), continuation: 1, items: [] },
    })).toThrow(/unknown piweb reserved custom type/i);
    for (const customType of [
      "piweb.pending_prompt_delivery.v1",
      "piweb.pending_prompt_batch.v1",
    ]) {
      expect(() => parseReservedConversationEntry({ customType, data: {} }))
        .toThrow(/unknown piweb reserved custom type/i);
    }

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

  it("replays the current LoopList and active-context timers from stable item ids", () => {
    const pending = createLoopListEntry({
      items: [
        { id: "implement", text: "Implement", status: "pending" },
        { id: "verify", text: "Verify", status: "pending" },
      ],
      armed: true,
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    const activeImplement = createLoopListEntry({
      items: [
        { id: "implement", text: "Implement", status: "active" },
        { id: "verify", text: "Verify", status: "pending" },
      ],
      armed: true,
      updatedAt: "2026-07-19T10:01:00.000Z",
    });
    const samePlanReordered = createLoopListEntry({
      items: [
        { id: "verify", text: "Verify thoroughly", status: "completed" },
        { id: "implement", text: "Implement carefully", status: "active" },
      ],
      armed: true,
      updatedAt: "2026-07-19T10:04:00.000Z",
    });
    const activeVerify = createLoopListEntry({
      items: [
        { id: "implement", text: "Implement carefully", status: "completed" },
        { id: "verify", text: "Verify thoroughly", status: "active" },
      ],
      armed: true,
      updatedAt: "2026-07-19T10:05:00.000Z",
    });
    const replacementPlan = createLoopListEntry({
      items: [{ id: "ship", text: "Ship", status: "active" }],
      armed: true,
      updatedAt: "2026-07-19T10:06:00.000Z",
    });
    const withoutActive = createLoopListEntry({
      items: [{ id: "ship", text: "Ship", status: "pending" }],
      armed: false,
      updatedAt: "2026-07-19T10:07:00.000Z",
    });
    const resumed = createLoopListEntry({
      items: [{ id: "ship", text: "Ship", status: "active" }],
      armed: true,
      updatedAt: "2026-07-19T10:08:00.000Z",
    });

    expect(aggregateReservedConversationEntries([pending]).loopListTiming)
      .toEqual({ listStartedAt: "2026-07-19T10:00:00.000Z" });
    expect(aggregateReservedConversationEntries([
      pending,
      activeImplement,
      samePlanReordered,
    ]).loopListTiming).toEqual({
      listStartedAt: "2026-07-19T10:00:00.000Z",
      activeStartedAt: "2026-07-19T10:01:00.000Z",
    });
    expect(aggregateReservedConversationEntries([
      pending,
      activeImplement,
      samePlanReordered,
      activeVerify,
    ]).loopListTiming).toEqual({
      listStartedAt: "2026-07-19T10:00:00.000Z",
      activeStartedAt: "2026-07-19T10:05:00.000Z",
    });
    expect(aggregateReservedConversationEntries([
      pending,
      activeImplement,
      activeVerify,
      replacementPlan,
    ]).loopListTiming).toEqual({
      listStartedAt: "2026-07-19T10:06:00.000Z",
      activeStartedAt: "2026-07-19T10:06:00.000Z",
    });
    expect(aggregateReservedConversationEntries([
      replacementPlan,
      withoutActive,
    ]).loopListTiming).toEqual({
      listStartedAt: "2026-07-19T10:06:00.000Z",
    });
    expect(aggregateReservedConversationEntries([
      replacementPlan,
      withoutActive,
      resumed,
    ]).loopListTiming).toEqual({
      listStartedAt: "2026-07-19T10:06:00.000Z",
      activeStartedAt: "2026-07-19T10:08:00.000Z",
    });
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

  it("requires current role snapshots and a selected tier on role changes", () => {
    const value = metadata();
    for (const field of [
      "compactionModel",
      "defaultThinkingLevel",
      "defaultServiceTier",
      "toolMode",
      "canManageSessions",
    ]) {
      const legacyRole: Record<string, unknown> = { ...value.role };
      delete legacyRole[field];
      expect(() => parseConversationMetaEntry({
        customType: CONVERSATION_META_CUSTOM_TYPE,
        data: { ...value, role: legacyRole },
      })).toThrow();
      expect(() => parseConversationCardEntry({
        customType: CONVERSATION_CARD_CUSTOM_TYPE,
        data: { ...card(), requestedRole: legacyRole },
      })).toThrow();
    }
    expect(() => parseConversationRoleChangeEntry({
      customType: CONVERSATION_ROLE_CHANGE_CUSTOM_TYPE,
      data: {
        role: value.role,
        changedAt: timestamp,
      },
    })).toThrow(/selectedServiceTier/i);
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
    })).toThrow(/kind|normal|invalid/i);
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

  it("records strict immutable message delivery receipts and rejects conflicting duplicates", () => {
    const value = deliveryReceipt();
    const entry = createMessageDeliveryReceiptEntry(value);

    expect(entry.customType).toBe(MESSAGE_DELIVERY_RECEIPT_CUSTOM_TYPE);
    expect(parseMessageDeliveryReceiptEntry(entry)).toEqual(entry);
    expect(parseReservedConversationEntry(entry)).toEqual({
      kind: "message_delivery_receipt",
      entry,
    });
    expect(aggregateReservedConversationEntries([entry, entry])).toMatchObject({
      deliveredMessageIds: [],
      messageDeliveryReceipts: [entry.data],
    });

    expect(() => parseMessageDeliveryReceiptEntry({
      ...entry,
      data: { ...entry.data, unknown: true },
    })).toThrow(/unknown|unrecognized/i);
    expect(() => createMessageDeliveryReceiptEntry({
      ...entry.data,
      payloadFingerprint: "A".repeat(64),
    })).toThrow(/payloadFingerprint/i);
    expect(() => aggregateReservedConversationEntries([
      entry,
      createMessageDeliveryReceiptEntry({
        ...entry.data,
        deliveredAt: "2026-07-19T10:03:00.000Z",
      }),
    ])).toThrow(/conflicting.*message delivery receipt/i);
  });

  it("records exact run settlements", () => {
    const pending = createRunSettlementEntry(settlement());

    expect(pending.customType).toBe(RUN_SETTLEMENT_CUSTOM_TYPE);
    expect(parseRunSettlementEntry(pending)).toEqual(pending);
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

  it("records bounded cumulative wait polls for recovered runs", () => {
    const first = createWaitPollEntry({ runId: randomUUID(), count: 1 });
    const second = createWaitPollEntry({
      runId: first.data.runId,
      count: 2,
    });

    expect(first.customType).toBe(WAIT_POLL_CUSTOM_TYPE);
    expect(parseWaitPollEntry(first)).toEqual(first);
    expect(parseReservedConversationEntry(first)).toEqual({
      kind: "wait_poll",
      entry: first,
    });
    expect(aggregateReservedConversationEntries([first, second]).waitPolls)
      .toEqual([first.data, second.data]);
    expect(() => aggregateReservedConversationEntries([first, first]))
      .toThrow(/wait-poll sequence.*expected 2.*got 1/i);
    expect(() => aggregateReservedConversationEntries([
      first,
      createWaitPollEntry({ runId: first.data.runId, count: 3 }),
    ])).toThrow(/wait-poll sequence.*expected 2.*got 3/i);
    expect(() => aggregateReservedConversationEntries([
      first,
      createRunSettlementEntry({
        ...settlement(),
        runId: first.data.runId,
      }),
      second,
    ])).toThrow(/wait poll cannot follow settlement/i);
    expect(() => parseWaitPollEntry({
      ...first,
      data: { ...first.data, count: 9 },
    })).toThrow(/less than or equal|8/i);
    expect(() => parseWaitPollEntry({
      ...first,
      data: { ...first.data, extra: true },
    })).toThrow(/unknown|unrecognized/i);
  });

  it("routes only known piweb reserved custom types", () => {
    const meta = createConversationMetaEntry(metadata());
    const cardEntry = createConversationCardEntry(card());
    const messageEntry = createConversationMessageEntry(message());
    const run = createRunSettlementEntry(settlement());
    const operation = createMetaOperationEntry(startedOperation());
    const waitPoll = createWaitPollEntry({ runId: randomUUID(), count: 1 });

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
    expect(parseReservedConversationEntry(waitPoll)).toEqual({
      kind: "wait_poll",
      entry: waitPoll,
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
      pending,
      operationStarted,
      operationCompleted,
      { customType: "extension.state", data: {} },
    ]);
    expect(aggregate.conversationMeta).toEqual(meta.data);
    expect(aggregate.cards).toEqual([finalCard.data]);
    expect(aggregate.deliveredMessageIds).toEqual([
      incoming.details.messageId,
    ]);
    expect(aggregate.runSettlements).toEqual([pending.data]);
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
