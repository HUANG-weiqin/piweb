import { z } from "zod";
import {
  MAX_COMPACTION_THRESHOLD_PERCENT,
  MIN_COMPACTION_THRESHOLD_PERCENT,
} from "../shared/protocol.js";

export const CONVERSATION_META_CUSTOM_TYPE =
  "piweb.conversation_meta.v1";
export const CONVERSATION_CARD_CUSTOM_TYPE =
  "piweb.conversation_card.v1";
export const CONVERSATION_MESSAGE_CUSTOM_TYPE =
  "piweb.conversation_message.v1";
export const RUN_SETTLEMENT_CUSTOM_TYPE =
  "piweb.run_settlement.v1";
export const PENDING_PROMPT_DELIVERY_CUSTOM_TYPE =
  "piweb.pending_prompt_delivery.v1";
export const META_OPERATION_CUSTOM_TYPE =
  "piweb.meta_operation.v1";
export const COMPACTION_THRESHOLD_CUSTOM_TYPE =
  "piweb.compaction_threshold.v1";
export const COMPACTION_RESUME_CUSTOM_TYPE =
  "piweb.compaction_resume.v1";
export const CONVERSATION_ROLE_CHANGE_CUSTOM_TYPE =
  "piweb.conversation_role_change.v1";
export const TEMPORARY_RETURN_RECEIPT_CUSTOM_TYPE =
  "piweb.temporary_return_receipt.v1";

export const MAX_ROLE_NAME_CHARACTERS = 80;
export const MAX_ROLE_DESCRIPTION_CHARACTERS = 1_000;
export const MAX_ROLE_SYSTEM_PROMPT_BYTES = 128 * 1024;
export const MAX_CONVERSATION_BODY_BYTES = 256 * 1024;
export const MAX_CONVERSATION_MESSAGE_CONTENT_BYTES =
  MAX_CONVERSATION_BODY_BYTES + 16 * 1024;
export const MAX_RUN_FINAL_TEXT_BYTES = 1024 * 1024;

const MAX_MODEL_REFERENCE_BYTES = 1024;
const MAX_ROLE_ID_BYTES = 128;
const MAX_CONVERSATION_ID_BYTES = 256;
const MAX_TITLE_BYTES = 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function limitedString(
  field: string,
  maximumBytes: number,
  options: {
    allowEmpty?: boolean;
    maximumCharacters?: number;
  } = {},
) {
  return z.string().superRefine((value, context) => {
    if (!options.allowEmpty && value.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must not be empty`,
      });
    }
    if (
      options.maximumCharacters !== undefined
      && [...value].length > options.maximumCharacters
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${field} exceeds ${options.maximumCharacters} characters`,
      });
    }
    if (utf8Bytes(value) > maximumBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} exceeds ${maximumBytes} UTF-8 bytes`,
      });
    }
  });
}

const uuidSchema = (field: string) =>
  z.string().regex(UUID_PATTERN, `${field} must be a canonical UUID`);

const conversationIdSchema = (field: string) =>
  z.string().superRefine((value, context) => {
    if (
      !SESSION_ID_PATTERN.test(value)
      || utf8Bytes(value) > MAX_CONVERSATION_ID_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must be a valid Pi conversation id`,
      });
    }
  });

const roleIdSchema = z.string().superRefine((value, context) => {
  if (
    utf8Bytes(value) > MAX_ROLE_ID_BYTES
    || (value !== "default" && !ROLE_UUID_PATTERN.test(value))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'role.id must be "default" or a UUID',
    });
  }
});

const canonicalTimestampSchema = (field: string) =>
  z.string().refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }, `${field} must be a canonical ISO timestamp`);

const roleReferenceSchema = z.object({
  id: roleIdSchema,
  name: limitedString("role.name", MAX_ROLE_NAME_CHARACTERS * 4, {
    maximumCharacters: MAX_ROLE_NAME_CHARACTERS,
  }).refine((value) => value.trim().length > 0, "role.name must not be blank"),
}).strict();

const conversationReferenceSnapshotSchema = z.object({
  conversationId: conversationIdSchema("conversationId"),
  title: limitedString("title", MAX_TITLE_BYTES).optional(),
  role: roleReferenceSchema,
}).strict();

const roleSnapshotSchema = z.object({
  id: roleIdSchema,
  revision: z.number().int().safe().positive(),
  name: limitedString("role.name", MAX_ROLE_NAME_CHARACTERS * 4, {
    maximumCharacters: MAX_ROLE_NAME_CHARACTERS,
  }).refine((value) => value.trim().length > 0, "role.name must not be blank"),
  description: limitedString(
    "role.description",
    MAX_ROLE_DESCRIPTION_CHARACTERS * 4,
    {
      allowEmpty: true,
      maximumCharacters: MAX_ROLE_DESCRIPTION_CHARACTERS,
    },
  ),
  systemPrompt: limitedString(
    "role.systemPrompt",
    MAX_ROLE_SYSTEM_PROMPT_BYTES,
    { allowEmpty: true },
  ),
  model: z.object({
    provider: limitedString(
      "role.model.provider",
      MAX_MODEL_REFERENCE_BYTES,
    ).refine(
      (value) => value.trim().length > 0,
      "role.model.provider must not be blank",
    ),
    id: limitedString(
      "role.model.id",
      MAX_MODEL_REFERENCE_BYTES,
    ).refine(
      (value) => value.trim().length > 0,
      "role.model.id must not be blank",
    ),
  }).strict(),
  // Conversation snapshots written before role-scoped defaults stay closed.
  defaultThinkingLevel: z.enum([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]).default("off"),
  // Conversation snapshots written before role permissions default closed.
  toolMode: z.enum(["read_only", "full_access"]).default("read_only"),
  // Session orchestration is opt-in for metadata written before this field.
  canManageSessions: z.boolean().default(false),
}).strict();

const lifecycleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("normal"),
  }).strict(),
  z.object({
    kind: z.literal("temporary"),
    callerConversationId: conversationIdSchema("callerConversationId"),
    delegationId: uuidSchema("delegationId"),
    returnMessageId: uuidSchema("returnMessageId"),
    initialRunId: uuidSchema("initialRunId"),
  }).strict(),
]);

const createdBySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
  }).strict(),
  z.object({
    kind: z.literal("conversation"),
    conversationId: conversationIdSchema("conversationId"),
  }).strict(),
]);

/**
 * Optional orchestration lineage for Agent-created peer sessions.
 * Written by the host on creation; absent in old JSONL and user-created
 * metadata written before this field existed.
 */
const orchestrationSchema = z.object({
  rootConversationId: conversationIdSchema("rootConversationId"),
  depth: z.number().int().safe().nonnegative(),
  sourceRunId: uuidSchema("sourceRunId").optional(),
}).strict();

const conversationMetaSchema = z.object({
  role: roleSnapshotSchema,
  lifecycle: lifecycleSchema,
  createdBy: createdBySchema,
  orchestration: orchestrationSchema.optional(),
}).strict();

const conversationMetaEntrySchema = z.object({
  customType: z.literal(CONVERSATION_META_CUSTOM_TYPE),
  data: conversationMetaSchema,
}).strict();

const conversationRoleChangeSchema = z.object({
  role: roleSnapshotSchema,
  changedAt: canonicalTimestampSchema("changedAt"),
}).strict();

const conversationRoleChangeEntrySchema = z.object({
  customType: z.literal(CONVERSATION_ROLE_CHANGE_CUSTOM_TYPE),
  data: conversationRoleChangeSchema,
}).strict();

const compactionThresholdSchema = z.object({
  percent: z.number().int()
    .min(MIN_COMPACTION_THRESHOLD_PERCENT)
    .max(MAX_COMPACTION_THRESHOLD_PERCENT),
  updatedAt: canonicalTimestampSchema("updatedAt"),
}).strict();

const compactionThresholdEntrySchema = z.object({
  customType: z.literal(COMPACTION_THRESHOLD_CUSTOM_TYPE),
  data: compactionThresholdSchema,
}).strict();

const conversationKindSchema = z.enum([
  "message",
  "delegation_task",
  "delegation_result",
  "delegation_failure",
]);

const conversationCardSchema = z.object({
  cardId: uuidSchema("cardId"),
  kind: conversationKindSchema,
  body: limitedString(
    "body",
    MAX_CONVERSATION_BODY_BYTES,
  ).refine((value) => value.trim().length > 0, "body must not be blank"),
  fromSnapshot: conversationReferenceSnapshotSchema,
  toSnapshot: conversationReferenceSnapshotSchema,
  state: z.enum([
    "sending",
    "queued",
    "delivered",
    "running",
    "waiting",
    "completed",
    "failed",
    "aborted",
  ]),
  messageId: uuidSchema("messageId").optional(),
  delegationId: uuidSchema("delegationId").optional(),
  runId: uuidSchema("runId").optional(),
  requestFingerprint: z.string().regex(
    SHA256_HEX_PATTERN,
    "requestFingerprint must be a lowercase SHA-256 hex digest",
  ).optional(),
  requestedRole: roleSnapshotSchema.optional(),
  orchestration: orchestrationSchema.optional(),
  result: limitedString(
    "result",
    MAX_RUN_FINAL_TEXT_BYTES,
    { allowEmpty: true },
  ).optional(),
  updatedAt: canonicalTimestampSchema("updatedAt"),
}).strict().superRefine((value, context) => {
  if (
    value.result !== undefined
    && value.state !== "completed"
    && value.state !== "failed"
    && value.state !== "aborted"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "result is only valid for completed, failed, or aborted cards",
      path: ["result"],
    });
  }
});

const conversationCardEntrySchema = z.object({
  customType: z.literal(CONVERSATION_CARD_CUSTOM_TYPE),
  data: conversationCardSchema,
}).strict();

const conversationMessageDetailsSchema = z.object({
  messageId: uuidSchema("messageId"),
  cardId: uuidSchema("cardId"),
  sentAt: canonicalTimestampSchema("sentAt"),
  kind: conversationKindSchema,
  body: limitedString(
    "body",
    MAX_CONVERSATION_BODY_BYTES,
  ).refine((value) => value.trim().length > 0, "body must not be blank"),
  fromSnapshot: conversationReferenceSnapshotSchema,
  toSnapshot: conversationReferenceSnapshotSchema,
  replyToMessageId: uuidSchema("replyToMessageId").optional(),
  delegationId: uuidSchema("delegationId").optional(),
}).strict();

const conversationMessageEntrySchema = z.object({
  customType: z.literal(CONVERSATION_MESSAGE_CUSTOM_TYPE),
  content: limitedString(
    "content",
    MAX_CONVERSATION_MESSAGE_CONTENT_BYTES,
  ).refine(
    (value) => value.trim().length > 0,
    "content must not be blank",
  ),
  display: z.literal(true),
  details: conversationMessageDetailsSchema,
}).strict();

const compactionResumeEntrySchema = z.object({
  customType: z.literal(COMPACTION_RESUME_CUSTOM_TYPE),
  content: limitedString(
    "content",
    MAX_CONVERSATION_MESSAGE_CONTENT_BYTES,
  ).refine(
    (value) => value.trim().length > 0,
    "content must not be blank",
  ),
  display: z.literal(false),
  details: z.object({
    runId: uuidSchema("runId"),
  }).strict(),
}).strict();

const runSettlementSchema = z.object({
  runId: uuidSchema("runId"),
  outcome: z.enum(["completed", "aborted", "failed"]),
  finalText: limitedString(
    "finalText",
    MAX_RUN_FINAL_TEXT_BYTES,
    { allowEmpty: true },
  ).nullable(),
  settledAt: canonicalTimestampSchema("settledAt"),
  reportedAt: canonicalTimestampSchema("reportedAt").optional(),
  returnMessageId: uuidSchema("returnMessageId").optional(),
}).strict().superRefine((value, context) => {
  if (
    (value.reportedAt === undefined)
    !== (value.returnMessageId === undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "reportedAt and returnMessageId must either both be present or both be absent",
      path: [
        value.reportedAt === undefined
          ? "reportedAt"
          : "returnMessageId",
      ],
    });
  }
});

const runSettlementEntrySchema = z.object({
  customType: z.literal(RUN_SETTLEMENT_CUSTOM_TYPE),
  data: runSettlementSchema,
}).strict();

const pendingPromptDeliverySchema = z.object({
  promptId: uuidSchema("promptId"),
  runId: uuidSchema("runId"),
  deliveredAt: canonicalTimestampSchema("deliveredAt"),
}).strict();

const pendingPromptDeliveryEntrySchema = z.object({
  customType: z.literal(PENDING_PROMPT_DELIVERY_CUSTOM_TYPE),
  data: pendingPromptDeliverySchema,
}).strict();

const temporaryReturnReceiptIdentitySchema = z.object({
  temporaryConversationId: conversationIdSchema("temporaryConversationId"),
  initialRunId: uuidSchema("initialRunId"),
  messageId: uuidSchema("messageId"),
  callerRunId: uuidSchema("callerRunId"),
  claimedAt: canonicalTimestampSchema("claimedAt"),
}).strict();

const temporaryReturnReceiptSchema = z.discriminatedUnion("state", [
  temporaryReturnReceiptIdentitySchema.extend({
    state: z.literal("claimed"),
  }).strict(),
  temporaryReturnReceiptIdentitySchema.extend({
    state: z.literal("settled"),
    settlement: runSettlementSchema,
  }).strict(),
]).superRefine((value, context) => {
  if (value.state !== "settled") return;
  if (
    value.settlement.runId !== value.initialRunId
    || value.settlement.returnMessageId !== value.messageId
    || value.settlement.reportedAt === undefined
    || value.settlement.outcome !== "completed"
    || value.settlement.finalText === null
    || value.settlement.finalText.trim().length === 0
    || Buffer.byteLength(value.settlement.finalText, "utf8")
      > MAX_CONVERSATION_BODY_BYTES
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "settled temporary return receipt must report a returnable initial run through its messageId",
      path: ["settlement"],
    });
  }
});

const temporaryReturnReceiptEntrySchema = z.object({
  customType: z.literal(TEMPORARY_RETURN_RECEIPT_CUSTOM_TYPE),
  data: temporaryReturnReceiptSchema,
}).strict();

const metaOperationBaseSchema = {
  operationId: uuidSchema("operationId"),
  targetConversationId: conversationIdSchema("targetConversationId"),
  updatedAt: canonicalTimestampSchema("updatedAt"),
};

const deleteMetaOperationCommonSchema = {
  ...metaOperationBaseSchema,
  kind: z.literal("delete_session"),
};

const abortMetaOperationResultSchema = z.union([
  z.object({
    aborted: z.literal(true),
  }).strict(),
  z.object({
    aborted: z.literal(false),
    reason: z.literal("run_not_active"),
  }).strict(),
]);

const abortMetaOperationCommonSchema = {
  ...metaOperationBaseSchema,
  kind: z.literal("abort_session"),
  runId: limitedString("runId", 200),
  result: abortMetaOperationResultSchema,
};

const metaOperationSchema = z.union([
  z.object({
    ...deleteMetaOperationCommonSchema,
    state: z.literal("started"),
  }).strict(),
  z.object({
    ...deleteMetaOperationCommonSchema,
    state: z.literal("completed"),
    deleted: z.boolean(),
  }).strict(),
  z.object({
    ...abortMetaOperationCommonSchema,
    state: z.literal("started"),
  }).strict(),
  z.object({
    ...abortMetaOperationCommonSchema,
    state: z.literal("completed"),
  }).strict(),
]);

const metaOperationEntrySchema = z.object({
  customType: z.literal(META_OPERATION_CUSTOM_TYPE),
  data: metaOperationSchema,
}).strict();

const piEntryIdSchema = z.string().regex(
  SESSION_ID_PATTERN,
  "entry id must be a valid Pi entry id",
);

const rawCustomEntrySchema = z.object({
  type: z.literal("custom"),
  id: piEntryIdSchema,
  parentId: piEntryIdSchema.nullable(),
  timestamp: canonicalTimestampSchema("timestamp"),
  customType: z.string(),
  data: z.unknown().optional(),
}).strict();

const rawCustomMessageEntrySchema = z.object({
  type: z.literal("custom_message"),
  id: piEntryIdSchema,
  parentId: piEntryIdSchema.nullable(),
  timestamp: canonicalTimestampSchema("timestamp"),
  customType: z.string(),
  content: z.unknown(),
  display: z.unknown(),
  details: z.unknown().optional(),
}).strict();

export type ConversationKind = z.infer<typeof conversationKindSchema>;
export type ConversationReferenceSnapshot =
  z.infer<typeof conversationReferenceSnapshotSchema>;
export type ConversationRoleSnapshot = z.infer<typeof roleSnapshotSchema>;
export type ConversationLifecycle = z.infer<typeof lifecycleSchema>;
export type ConversationCreatedBy = z.infer<typeof createdBySchema>;
export type ConversationMeta = z.infer<typeof conversationMetaSchema>;
export type ConversationOrchestration = z.infer<typeof orchestrationSchema>;
export type ConversationMetaEntry =
  z.infer<typeof conversationMetaEntrySchema>;
export type ConversationRoleChange =
  z.infer<typeof conversationRoleChangeSchema>;
export type ConversationRoleChangeEntry =
  z.infer<typeof conversationRoleChangeEntrySchema>;
export type ConversationCard = z.infer<typeof conversationCardSchema>;
export type ConversationCardEntry =
  z.infer<typeof conversationCardEntrySchema>;
export type ConversationMessageDetails =
  z.infer<typeof conversationMessageDetailsSchema>;
export type ConversationMessageEntry =
  z.infer<typeof conversationMessageEntrySchema>;
export type CompactionResumeEntry =
  z.infer<typeof compactionResumeEntrySchema>;
export type RunSettlement = z.infer<typeof runSettlementSchema>;
export type RunSettlementEntry =
  z.infer<typeof runSettlementEntrySchema>;
export type PendingPromptDelivery =
  z.infer<typeof pendingPromptDeliverySchema>;
export type PendingPromptDeliveryEntry =
  z.infer<typeof pendingPromptDeliveryEntrySchema>;
export type TemporaryReturnReceipt =
  z.infer<typeof temporaryReturnReceiptSchema>;
export type TemporaryReturnReceiptEntry =
  z.infer<typeof temporaryReturnReceiptEntrySchema>;
export type MetaOperation = z.infer<typeof metaOperationSchema>;
export type MetaOperationEntry =
  z.infer<typeof metaOperationEntrySchema>;
export type CompactionThreshold =
  z.infer<typeof compactionThresholdSchema>;
export type CompactionThresholdEntry =
  z.infer<typeof compactionThresholdEntrySchema>;

export interface CustomEntryAppender {
  appendCustomEntry(customType: string, data?: unknown): string;
}

export type ReservedConversationEntry =
  | {
      kind: "conversation_meta";
      entry: ConversationMetaEntry;
    }
  | {
      kind: "conversation_role_change";
      entry: ConversationRoleChangeEntry;
    }
  | {
      kind: "conversation_card";
      entry: ConversationCardEntry;
    }
  | {
      kind: "conversation_message";
      entry: ConversationMessageEntry;
    }
  | {
      kind: "compaction_resume";
      entry: CompactionResumeEntry;
    }
  | {
      kind: "run_settlement";
      entry: RunSettlementEntry;
    }
  | {
      kind: "pending_prompt_delivery";
      entry: PendingPromptDeliveryEntry;
    }
  | {
      kind: "temporary_return_receipt";
      entry: TemporaryReturnReceiptEntry;
    }
  | {
      kind: "meta_operation";
      entry: MetaOperationEntry;
    }
  | {
      kind: "compaction_threshold";
      entry: CompactionThresholdEntry;
    };

export interface ReservedConversationAggregate {
  conversationMeta?: ConversationMeta;
  cards: ConversationCard[];
  deliveredMessageIds: string[];
  runSettlements: RunSettlement[];
  pendingPromptDeliveries: PendingPromptDelivery[];
  temporaryReturnReceipts: TemporaryReturnReceipt[];
  metaOperations: MetaOperation[];
  compactionThreshold?: CompactionThreshold;
}

export function parseConversationReferenceSnapshot(
  value: unknown,
): ConversationReferenceSnapshot {
  return conversationReferenceSnapshotSchema.parse(value);
}

export function parseConversationMetaEntry(
  value: unknown,
): ConversationMetaEntry {
  return conversationMetaEntrySchema.parse(value);
}

export function createConversationMetaEntry(
  data: ConversationMeta,
): ConversationMetaEntry {
  return parseConversationMetaEntry({
    customType: CONVERSATION_META_CUSTOM_TYPE,
    data,
  });
}

export function parseConversationRoleChangeEntry(
  value: unknown,
): ConversationRoleChangeEntry {
  return conversationRoleChangeEntrySchema.parse(value);
}

export function createConversationRoleChangeEntry(
  data: ConversationRoleChange,
): ConversationRoleChangeEntry {
  return parseConversationRoleChangeEntry({
    customType: CONVERSATION_ROLE_CHANGE_CUSTOM_TYPE,
    data,
  });
}

export function parseConversationCardEntry(
  value: unknown,
): ConversationCardEntry {
  return conversationCardEntrySchema.parse(value);
}

export function createConversationCardEntry(
  data: ConversationCard,
): ConversationCardEntry {
  return parseConversationCardEntry({
    customType: CONVERSATION_CARD_CUSTOM_TYPE,
    data,
  });
}

export function parseConversationMessageEntry(
  value: unknown,
): ConversationMessageEntry {
  return conversationMessageEntrySchema.parse(value);
}

export function parseCompactionResumeEntry(
  value: unknown,
): CompactionResumeEntry {
  return compactionResumeEntrySchema.parse(value);
}

/**
 * Builds the exact payload accepted by AgentSession.sendCustomMessage().
 *
 * For an already-created AgentSession, do not call
 * SessionManager.appendCustomMessageEntry() directly: that writes JSONL but
 * does not synchronize the Agent's in-memory messages. The owning actor must
 * install run ownership first and use AgentSession.sendCustomMessage().
 */
export function createConversationMessageEntry(
  value: Omit<ConversationMessageEntry, "customType">,
): ConversationMessageEntry {
  return parseConversationMessageEntry({
    customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
    ...value,
  });
}

export function createCompactionResumeEntry(
  value: Omit<CompactionResumeEntry, "customType">,
): CompactionResumeEntry {
  return parseCompactionResumeEntry({
    customType: COMPACTION_RESUME_CUSTOM_TYPE,
    ...value,
  });
}

export function parseRunSettlementEntry(
  value: unknown,
): RunSettlementEntry {
  return runSettlementEntrySchema.parse(value);
}

export function createRunSettlementEntry(
  data: RunSettlement,
): RunSettlementEntry {
  return parseRunSettlementEntry({
    customType: RUN_SETTLEMENT_CUSTOM_TYPE,
    data,
  });
}

export function parsePendingPromptDeliveryEntry(
  value: unknown,
): PendingPromptDeliveryEntry {
  return pendingPromptDeliveryEntrySchema.parse(value);
}

export function createPendingPromptDeliveryEntry(
  data: PendingPromptDelivery,
): PendingPromptDeliveryEntry {
  return parsePendingPromptDeliveryEntry({
    customType: PENDING_PROMPT_DELIVERY_CUSTOM_TYPE,
    data,
  });
}

export function parseTemporaryReturnReceiptEntry(
  value: unknown,
): TemporaryReturnReceiptEntry {
  return temporaryReturnReceiptEntrySchema.parse(value);
}

export function createTemporaryReturnReceiptEntry(
  data: TemporaryReturnReceipt,
): TemporaryReturnReceiptEntry {
  return parseTemporaryReturnReceiptEntry({
    customType: TEMPORARY_RETURN_RECEIPT_CUSTOM_TYPE,
    data,
  });
}

export function parseMetaOperationEntry(
  value: unknown,
): MetaOperationEntry {
  return metaOperationEntrySchema.parse(value);
}

export function createMetaOperationEntry(
  data: MetaOperation,
): MetaOperationEntry {
  return parseMetaOperationEntry({
    customType: META_OPERATION_CUSTOM_TYPE,
    data,
  });
}

export function parseCompactionThresholdEntry(
  value: unknown,
): CompactionThresholdEntry {
  return compactionThresholdEntrySchema.parse(value);
}

export function createCompactionThresholdEntry(
  data: CompactionThreshold,
): CompactionThresholdEntry {
  return parseCompactionThresholdEntry({
    customType: COMPACTION_THRESHOLD_CUSTOM_TYPE,
    data,
  });
}

/**
 * Appends a validated deep snapshot to Pi's non-context custom-entry path.
 *
 * Pending new sessions may use this before the host writes header + metadata
 * together. Re-parsing here matters because Pi retains the data reference.
 */
export function appendReservedCustomEntry(
  appender: CustomEntryAppender,
  value:
    | ConversationMetaEntry
    | ConversationRoleChangeEntry
    | ConversationCardEntry
    | RunSettlementEntry
    | PendingPromptDeliveryEntry
    | TemporaryReturnReceiptEntry
    | MetaOperationEntry
    | CompactionThresholdEntry,
): string {
  const reserved = parseReservedConversationEntry(value);
  if (
    reserved === undefined
    || reserved.kind === "conversation_message"
    || reserved.kind === "compaction_resume"
  ) {
    throw new Error("Expected a non-context piweb reserved custom entry");
  }
  return appender.appendCustomEntry(
    reserved.entry.customType,
    reserved.entry.data,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
  );
}

function normalizeReservedCarrier(
  value: Record<string, unknown>,
): unknown {
  if (value.type === undefined) return value;
  if (value.type === "custom") {
    const entry = rawCustomEntrySchema.parse(value);
    return {
      customType: entry.customType,
      data: entry.data,
    };
  }
  if (value.type === "custom_message") {
    const entry = rawCustomMessageEntrySchema.parse(value);
    return {
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
    };
  }
  throw new Error(
    `Piweb reserved custom type is stored in the wrong carrier: ${String(value.type)}`,
  );
}

export function parseReservedConversationEntry(
  value: unknown,
): ReservedConversationEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "message"
    && isRecord(value.message)
    && value.message.role === "custom"
    && typeof value.message.customType === "string"
    && value.message.customType.startsWith("piweb.")
  ) {
    throw new Error(
      "Piweb reserved custom type is stored in nested message.role=custom",
    );
  }
  const customType = value.customType;
  if (typeof customType !== "string" || !customType.startsWith("piweb.")) {
    return undefined;
  }
  const payload = normalizeReservedCarrier(value);

  if (customType === CONVERSATION_META_CUSTOM_TYPE) {
    return {
      kind: "conversation_meta",
      entry: parseConversationMetaEntry(payload),
    };
  }
  if (customType === CONVERSATION_ROLE_CHANGE_CUSTOM_TYPE) {
    return {
      kind: "conversation_role_change",
      entry: parseConversationRoleChangeEntry(payload),
    };
  }
  if (customType === CONVERSATION_CARD_CUSTOM_TYPE) {
    return {
      kind: "conversation_card",
      entry: parseConversationCardEntry(payload),
    };
  }
  if (customType === CONVERSATION_MESSAGE_CUSTOM_TYPE) {
    return {
      kind: "conversation_message",
      entry: parseConversationMessageEntry(payload),
    };
  }
  if (customType === COMPACTION_RESUME_CUSTOM_TYPE) {
    return {
      kind: "compaction_resume",
      entry: parseCompactionResumeEntry(payload),
    };
  }
  if (customType === RUN_SETTLEMENT_CUSTOM_TYPE) {
    return {
      kind: "run_settlement",
      entry: parseRunSettlementEntry(payload),
    };
  }
  if (customType === PENDING_PROMPT_DELIVERY_CUSTOM_TYPE) {
    return {
      kind: "pending_prompt_delivery",
      entry: parsePendingPromptDeliveryEntry(payload),
    };
  }
  if (customType === TEMPORARY_RETURN_RECEIPT_CUSTOM_TYPE) {
    return {
      kind: "temporary_return_receipt",
      entry: parseTemporaryReturnReceiptEntry(payload),
    };
  }
  if (customType === META_OPERATION_CUSTOM_TYPE) {
    return {
      kind: "meta_operation",
      entry: parseMetaOperationEntry(payload),
    };
  }
  if (customType === COMPACTION_THRESHOLD_CUSTOM_TYPE) {
    return {
      kind: "compaction_threshold",
      entry: parseCompactionThresholdEntry(payload),
    };
  }
  throw new Error(`Unknown piweb reserved custom type: ${customType}`);
}

function settlementCore(settlement: RunSettlement): string {
  return JSON.stringify({
    runId: settlement.runId,
    outcome: settlement.outcome,
    finalText: settlement.finalText,
    settledAt: settlement.settledAt,
  });
}

const TERMINAL_CARD_STATES = new Set<ConversationCard["state"]>([
  "completed",
  "failed",
  "aborted",
]);

const ALLOWED_CARD_TRANSITIONS: Readonly<
  Record<
    ConversationCard["state"],
    ReadonlySet<ConversationCard["state"]>
  >
> = {
  sending: new Set([
    "sending",
    "queued",
    "delivered",
    "running",
    "waiting",
    "completed",
    "failed",
    "aborted",
  ]),
  queued: new Set([
    "queued",
    "delivered",
    "running",
    "waiting",
    "completed",
    "failed",
    "aborted",
  ]),
  delivered: new Set([
    "delivered",
    "running",
    "waiting",
    "completed",
    "failed",
    "aborted",
  ]),
  running: new Set([
    "running",
    "waiting",
    "completed",
    "failed",
    "aborted",
  ]),
  waiting: new Set([
    "waiting",
    "completed",
    "failed",
    "aborted",
  ]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  aborted: new Set(["aborted"]),
};

function cardIdentity(card: ConversationCard): string {
  return JSON.stringify({
    kind: card.kind,
    body: card.body,
    fromSnapshot: card.fromSnapshot,
    toSnapshot: card.toSnapshot,
    messageId: card.messageId,
    delegationId: card.delegationId,
    requestFingerprint: card.requestFingerprint,
    requestedRole: card.requestedRole,
    orchestration: card.orchestration,
  });
}

function assertCardUpdate(
  existing: ConversationCard,
  incoming: ConversationCard,
): void {
  if (cardIdentity(existing) !== cardIdentity(incoming)) {
    throw new Error(
      `Conflicting piweb conversation card identity for cardId ${incoming.cardId}`,
    );
  }
  if (Date.parse(incoming.updatedAt) < Date.parse(existing.updatedAt)) {
    throw new Error(
      `Piweb conversation card updatedAt cannot regress for cardId ${incoming.cardId}`,
    );
  }
  if (
    existing.runId !== undefined
    && incoming.runId !== existing.runId
  ) {
    throw new Error(
      `Piweb conversation card runId cannot change or disappear for cardId ${incoming.cardId}`,
    );
  }
  if (!ALLOWED_CARD_TRANSITIONS[existing.state].has(incoming.state)) {
    throw new Error(
      `Piweb conversation card state cannot regress or change terminal outcome for cardId ${incoming.cardId}`,
    );
  }
  if (
    TERMINAL_CARD_STATES.has(existing.state)
    && existing.result !== incoming.result
  ) {
    throw new Error(
      `Piweb conversation card terminal result cannot change for cardId ${incoming.cardId}`,
    );
  }
}

export function aggregateReservedConversationEntries(
  values: readonly unknown[],
): ReservedConversationAggregate {
  let conversationMeta: ConversationMeta | undefined;
  const cards = new Map<string, ConversationCard>();
  const deliveredMessageIds = new Set<string>();
  const runSettlements = new Map<string, RunSettlement>();
  const pendingPromptDeliveries = new Map<string, PendingPromptDelivery>();
  const temporaryReturnReceipts = new Map<
    string,
    TemporaryReturnReceipt
  >();
  const metaOperations = new Map<string, MetaOperation>();
  let compactionThreshold: CompactionThreshold | undefined;
  let roleChangedAt: string | undefined;

  for (const value of values) {
    const reserved = parseReservedConversationEntry(value);
    if (reserved === undefined) continue;
    if (reserved.kind === "conversation_meta") {
      if (conversationMeta !== undefined) {
        throw new Error("Duplicate piweb conversation metadata");
      }
      conversationMeta = reserved.entry.data;
      continue;
    }
    if (reserved.kind === "conversation_role_change") {
      if (conversationMeta === undefined) {
        throw new Error(
          "Piweb conversation role changed before conversation metadata",
        );
      }
      if (
        roleChangedAt !== undefined
        && Date.parse(reserved.entry.data.changedAt) < Date.parse(roleChangedAt)
      ) {
        throw new Error("Piweb conversation role changedAt cannot regress");
      }
      conversationMeta = {
        ...conversationMeta,
        role: reserved.entry.data.role,
      };
      roleChangedAt = reserved.entry.data.changedAt;
      continue;
    }
    if (reserved.kind === "conversation_card") {
      const incoming = reserved.entry.data;
      const existing = cards.get(incoming.cardId);
      if (existing !== undefined) {
        assertCardUpdate(existing, incoming);
      }
      cards.set(incoming.cardId, incoming);
      continue;
    }
    if (reserved.kind === "conversation_message") {
      const { messageId } = reserved.entry.details;
      if (deliveredMessageIds.has(messageId)) {
        throw new Error(
          `Duplicate delivered piweb messageId: ${messageId}`,
        );
      }
      deliveredMessageIds.add(messageId);
      continue;
    }
    if (reserved.kind === "compaction_resume") {
      continue;
    }
    if (reserved.kind === "pending_prompt_delivery") {
      const incoming = reserved.entry.data;
      const existingPrompt = pendingPromptDeliveries.get(incoming.promptId);
      if (
        existingPrompt !== undefined
        && JSON.stringify(existingPrompt) !== JSON.stringify(incoming)
      ) {
        throw new Error(
          `Conflicting piweb pending prompt delivery for promptId ${incoming.promptId}`,
        );
      }
      pendingPromptDeliveries.set(incoming.promptId, incoming);
      continue;
    }
    if (reserved.kind === "temporary_return_receipt") {
      const incoming = reserved.entry.data;
      const key = `${incoming.temporaryConversationId.length}:${incoming.temporaryConversationId}:${incoming.initialRunId}`;
      const delegation = [...cards.values()].find((card) =>
        card.kind === "delegation_task"
        && card.toSnapshot.conversationId === incoming.temporaryConversationId
        && card.runId === incoming.initialRunId
      );
      if (!delegation) {
        throw new Error(
          "Piweb temporary return receipt requires an earlier initial delegation card",
        );
      }
      const existing = temporaryReturnReceipts.get(key);
      if (existing === undefined) {
        if (incoming.state !== "claimed") {
          throw new Error(
            "Piweb temporary return receipt must begin in claimed state",
          );
        }
        temporaryReturnReceipts.set(key, incoming);
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(incoming)) continue;
      const sameIdentity = JSON.stringify({
        temporaryConversationId: existing.temporaryConversationId,
        initialRunId: existing.initialRunId,
        messageId: existing.messageId,
        callerRunId: existing.callerRunId,
        claimedAt: existing.claimedAt,
      }) === JSON.stringify({
        temporaryConversationId: incoming.temporaryConversationId,
        initialRunId: incoming.initialRunId,
        messageId: incoming.messageId,
        callerRunId: incoming.callerRunId,
        claimedAt: incoming.claimedAt,
      });
      if (!sameIdentity) {
        throw new Error(
          `Conflicting piweb temporary return receipt for ${key}`,
        );
      }
      if (existing.state !== "claimed" || incoming.state !== "settled") {
        throw new Error(
          `Piweb temporary return receipt state cannot regress for ${key}`,
        );
      }
      temporaryReturnReceipts.set(key, incoming);
      continue;
    }
    if (reserved.kind === "meta_operation") {
      const incoming = reserved.entry.data;
      const existing = metaOperations.get(incoming.operationId);
      if (existing === undefined) {
        if (incoming.state !== "started") {
          throw new Error(
            `Piweb meta operation ${incoming.operationId} completed without a started state`,
          );
        }
        metaOperations.set(incoming.operationId, incoming);
        continue;
      }
      if (
        existing.kind !== incoming.kind
        || existing.targetConversationId
          !== incoming.targetConversationId
        || (
          existing.kind === "abort_session"
          && incoming.kind === "abort_session"
          && existing.runId !== incoming.runId
        )
      ) {
        throw new Error(
          `Conflicting piweb meta operation identity for operationId ${incoming.operationId}`,
        );
      }
      if (
        existing.kind === "abort_session"
        && incoming.kind === "abort_session"
        && JSON.stringify(existing.result) !== JSON.stringify(incoming.result)
      ) {
        throw new Error(
          `Conflicting piweb meta operation result for operationId ${incoming.operationId}`,
        );
      }
      if (Date.parse(incoming.updatedAt) < Date.parse(existing.updatedAt)) {
        throw new Error(
          `Piweb meta operation updatedAt cannot regress for operationId ${incoming.operationId}`,
        );
      }
      if (
        existing.state === "completed"
        && incoming.state === "started"
      ) {
        throw new Error(
          `Piweb meta operation state cannot regress for operationId ${incoming.operationId}`,
        );
      }
      if (
        existing.kind === "delete_session"
        && incoming.kind === "delete_session"
        && existing.state === "completed"
        && incoming.state === "completed"
        && existing.deleted !== incoming.deleted
      ) {
        throw new Error(
          `Conflicting piweb meta operation result for operationId ${incoming.operationId}`,
        );
      }
      metaOperations.set(incoming.operationId, incoming);
      continue;
    }
    if (reserved.kind === "compaction_threshold") {
      if (
        compactionThreshold
        && Date.parse(reserved.entry.data.updatedAt)
          < Date.parse(compactionThreshold.updatedAt)
      ) {
        throw new Error(
          "Piweb compaction threshold updatedAt cannot regress",
        );
      }
      compactionThreshold = reserved.entry.data;
      continue;
    }

    const incoming = reserved.entry.data;
    const existing = runSettlements.get(incoming.runId);
    if (existing === undefined) {
      runSettlements.set(incoming.runId, incoming);
      continue;
    }
    if (JSON.stringify(existing) === JSON.stringify(incoming)) {
      continue;
    }
    if (settlementCore(existing) !== settlementCore(incoming)) {
      throw new Error(
        `Conflicting piweb run settlement for runId ${incoming.runId}`,
      );
    }
    if (existing.reportedAt !== undefined) {
      throw new Error(
        `Piweb run settlement report state cannot change or regress for runId ${incoming.runId}`,
      );
    }
    if (incoming.reportedAt === undefined) {
      throw new Error(
        `Conflicting pending piweb run settlement for runId ${incoming.runId}`,
      );
    }
    runSettlements.set(incoming.runId, incoming);
  }

  return {
    ...(conversationMeta === undefined
      ? {}
      : { conversationMeta }),
    cards: [...cards.values()],
    deliveredMessageIds: [...deliveredMessageIds],
    runSettlements: [...runSettlements.values()],
    pendingPromptDeliveries: [...pendingPromptDeliveries.values()],
    temporaryReturnReceipts: [...temporaryReturnReceipts.values()],
    metaOperations: [...metaOperations.values()],
    ...(compactionThreshold === undefined
      ? {}
      : { compactionThreshold }),
  };
}
