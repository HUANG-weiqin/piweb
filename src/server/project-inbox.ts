import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import { z } from "zod";
import {
  MAX_CONVERSATION_BODY_BYTES,
  normalizeConversationMessageSummary,
  parseConversationReferenceSnapshot,
  type ConversationKind,
  type ConversationReferenceSnapshot,
} from "./conversation-meta.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

const INBOX_ENVELOPE_VERSION = 1;
const INBOX_TARGET_TOMBSTONE_VERSION = 1;
export const MAX_INBOX_MESSAGES_PER_PROJECT = 256;
export const MAX_INBOX_MESSAGES_PER_TARGET = 64;
const MAX_INBOX_TOMBSTONES_PER_PROJECT = 1_024;
export const MAX_INBOX_TOTAL_BYTES = 32 * 1024 * 1024;
// Canonical tombstones are bounded independently so a full envelope
// reservation can always create a deletion fence.
const MAX_INBOX_TOMBSTONE_TOTAL_BYTES = 1 * 1024 * 1024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONVERSATION_ID_BYTES = 256;
const INBOX_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const TARGET_TOMBSTONE_FILE_PATTERN =
  /^target-([0-9a-f]{64})\.tombstone\.json$/;
const INBOX_ARTIFACT_PATTERN =
  /^\.((?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json)|(?:target-[0-9a-f]{64}\.tombstone\.json))\.(create|replace|delete)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(tmp|quarantine)$/;

const uuidSchema = (field: string) =>
  z.string().regex(UUID_PATTERN, `${field} must be a canonical UUID`);

const canonicalTimestampSchema = (field: string) =>
  z.string().refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }, `${field} must be a canonical ISO timestamp`);

const conversationIdSchema = (field: string) =>
  z.string().superRefine((value, context) => {
    if (
      !SESSION_ID_PATTERN.test(value)
      || Buffer.byteLength(value, "utf8") > MAX_CONVERSATION_ID_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must be a valid Pi conversation id`,
      });
    }
  });

const conversationMessageSummarySchema = z.string().transform(
  (value, context) => {
    try {
      return normalizeConversationMessageSummary(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  },
);

const envelopeSchema = z.object({
  version: z.literal(INBOX_ENVELOPE_VERSION),
  messageId: uuidSchema("messageId"),
  cardId: uuidSchema("cardId"),
  fromConversationId: conversationIdSchema("fromConversationId"),
  toConversationId: conversationIdSchema("toConversationId"),
  sentAt: canonicalTimestampSchema("sentAt"),
  kind: z.enum([
    "message",
    "delegation_task",
  ]),
  body: z.string(),
  summary: conversationMessageSummarySchema.optional(),
  replyToMessageId: uuidSchema("replyToMessageId").optional(),
  delegationId: uuidSchema("delegationId").optional(),
  requestFingerprint: z.string().regex(
    SHA256_HEX_PATTERN,
    "requestFingerprint must be a lowercase SHA-256 hex digest",
  ).optional(),
  fromRunId: uuidSchema("fromRunId"),
  fromSnapshot: z.unknown(),
  toSnapshot: z.unknown(),
  state: z.enum(["queued", "processing"]),
  processingRunId: uuidSchema("processingRunId").optional(),
  processingDelivery: z.literal("steer").optional(),
  waitedByRunId: uuidSchema("waitedByRunId").optional(),
}).strict();

const stateUpdateSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("queued"),
  }).strict(),
  z.object({
    state: z.literal("processing"),
    processingRunId: uuidSchema("processingRunId"),
    processingDelivery: z.literal("steer").optional(),
    waitedByRunId: uuidSchema("waitedByRunId").optional(),
  }).strict(),
]);

const listOptionsSchema = z.object({
  toConversationId: conversationIdSchema("toConversationId").optional(),
}).strict();

const targetTombstoneSchema = z.object({
  version: z.literal(INBOX_TARGET_TOMBSTONE_VERSION),
  conversationId: conversationIdSchema("conversationId"),
  deletedAt: canonicalTimestampSchema("deletedAt"),
}).strict();

export interface InboxEnvelope {
  version: typeof INBOX_ENVELOPE_VERSION;
  messageId: string;
  cardId: string;
  fromConversationId: string;
  toConversationId: string;
  sentAt: string;
  kind: ConversationKind;
  body: string;
  summary?: string;
  replyToMessageId?: string;
  delegationId?: string;
  requestFingerprint?: string;
  /** Frozen source run correlation used by durable wait rendezvous. */
  fromRunId: string;
  fromSnapshot: ConversationReferenceSnapshot;
  toSnapshot: ConversationReferenceSnapshot;
  state: "queued" | "processing";
  processingRunId?: string;
  /** A claimed custom steer must be retried if its exact run settles unmarked. */
  processingDelivery?: "steer";
  /** Exact receiving run whose wait already observed this message. */
  waitedByRunId?: string;
}

export type InboxEnvelopeInput = Omit<
  InboxEnvelope,
  | "version"
  | "state"
  | "processingRunId"
  | "processingDelivery"
  | "waitedByRunId"
>;

export type InboxStateUpdate =
  | { state: "queued" }
  | {
      state: "processing";
      processingRunId: string;
      processingDelivery?: "steer";
      waitedByRunId?: string;
    };

export interface InboxPutOptions {
  initialState?: InboxStateUpdate;
}

export interface InboxPutResult {
  status: "created" | "existing";
  envelope: InboxEnvelope;
}

/**
 * Whether this put operation can still prove it made no durable publication.
 * Callers must not infer this from a later global inbox census: another actor
 * may have consumed a sidecar that this operation already published.
 */
export type InboxPutOutcome =
  | "definitely_noncommitted"
  | "committed_or_unknown";

export class InboxPutOperationError extends Error {
  constructor(
    readonly outcome: InboxPutOutcome,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Inbox put ${outcome}: ${detail}`, { cause });
  }
}

export interface InboxListOptions {
  toConversationId?: string;
}

/** The deletion fence is durable even though its post-write proof failed. */
export class InboxTargetTombstoneCommittedError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, cause: unknown) {
    super(
      `Inbox target tombstone committed but could not be verified: ${conversationId}`,
      { cause },
    );
    this.conversationId = conversationId;
  }
}

/**
 * A batch started writing deletion fences but did not complete its final
 * census. Every listed durable ID must remain reserved; uncertain IDs may
 * have published even though their final census could not prove it.
 */
export class InboxTargetTombstoneBatchError extends Error {
  constructor(
    readonly durableConversationIds: readonly string[],
    readonly uncertainConversationIds: readonly string[],
    cause: unknown,
  ) {
    super(
      uncertainConversationIds.length > 0
        ? "Inbox target tombstone batch committed but could not be verified"
        : "Inbox target tombstone batch could not be completed",
      { cause },
    );
  }
}

/**
 * A target-fence clear stopped after exact deletes had already completed.
 * Only IDs in this receipt returned successfully from deleteStoredFile().
 */
export class InboxTargetTombstoneBatchClearError extends Error {
  readonly clearedConversationIds: readonly string[];

  constructor(clearedConversationIds: readonly string[], cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Inbox target tombstone batch cleanup could not be completed: ${detail}`, {
      cause,
    });
    this.clearedConversationIds = Object.freeze([...clearedConversationIds]);
  }
}

export interface InboxTargetDeletionBatch {
  readonly conversationIds: readonly string[];
  readonly pending: readonly InboxEnvelope[];
}

/** link() published the new inode, but its post-publication proof failed. */
class InboxFilePublishedError extends Error {
  constructor(
    readonly targetPath: string,
    cause: unknown,
  ) {
    super(`Inbox entry published but could not be verified: ${targetPath}`, {
      cause,
    });
  }
}

/** rename() removed the original inode, but its cleanup could not be verified. */
class InboxFileDeletedError extends Error {
  constructor(
    readonly targetPath: string,
    cause: unknown,
  ) {
    super(`Inbox entry deleted but could not be verified: ${targetPath}`, {
      cause,
    });
  }
}

interface StoredInboxFile {
  path: string;
  information: Stats;
}

interface StoredEnvelope extends StoredInboxFile {
  envelope: InboxEnvelope;
  bytes: number;
}

interface InboxTargetTombstone {
  version: typeof INBOX_TARGET_TOMBSTONE_VERSION;
  conversationId: string;
  deletedAt: string;
}

interface StoredTargetTombstone extends StoredInboxFile {
  tombstone: InboxTargetTombstone;
}

type InboxMutationOperation = "create" | "replace" | "delete";
type InboxArtifactStage = "tmp" | "quarantine";

interface StagedInboxFile {
  originalPath: string;
  temporaryPath: string;
  information: Stats;
  operation: InboxMutationOperation;
  transactionId: string;
}

interface QuarantinedInboxFile {
  originalPath: string;
  quarantinePath: string;
  information: Stats;
  operation: InboxMutationOperation;
  transactionId: string;
}

interface InboxArtifact {
  originalPath: string;
  path: string;
  information: Stats;
  operation: InboxMutationOperation;
  transactionId: string;
  stage: InboxArtifactStage;
}

interface InboxScan {
  directoryInformation: Stats;
  envelopes: StoredEnvelope[];
  tombstones: StoredTargetTombstone[];
  totalBytes: number;
  tombstoneBytes: number;
  reservedBytes: number;
}

interface InboxListSnapshot {
  scan: InboxScan;
  mutationRevision: number;
}

interface CapturedInboxTargetDeletionBatch extends InboxTargetDeletionBatch {
  owner: ProjectInbox;
  pendingFiles: readonly StoredEnvelope[];
  tombstoneFiles: readonly StoredTargetTombstone[];
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code
  );
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function pathsAreIdentical(first: string, second: string): boolean {
  return pathIdentity(first) === pathIdentity(second);
}

function statsAreIdentical(first: Stats, second: Stats): boolean {
  return (
    first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.isFile() === second.isFile()
  );
}

function snapshotStatsAreIdentical(first: Stats, second: Stats): boolean {
  return statsAreIdentical(first, second) && first.ctimeMs === second.ctimeMs;
}

function storedFilesAreIdentical(
  first: StoredInboxFile,
  second: StoredInboxFile,
): boolean {
  return pathsAreIdentical(first.path, second.path)
    && statsAreIdentical(first.information, second.information);
}

function cloneEnvelope(envelope: InboxEnvelope): InboxEnvelope {
  return {
    ...envelope,
    fromSnapshot: {
      ...envelope.fromSnapshot,
      role: { ...envelope.fromSnapshot.role },
    },
    toSnapshot: {
      ...envelope.toSnapshot,
      role: { ...envelope.toSnapshot.role },
    },
  };
}

function serializeEnvelope(envelope: InboxEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function serializeTargetTombstone(
  tombstone: InboxTargetTombstone,
): string {
  return `${JSON.stringify(tombstone, null, 2)}\n`;
}

function parseTargetTombstone(value: unknown): InboxTargetTombstone {
  return targetTombstoneSchema.parse(value);
}

function targetIdentity(conversationId: string): string {
  return createHash("sha256").update(conversationId, "utf8").digest("hex");
}

function immutablePayload(envelope: InboxEnvelope): InboxEnvelopeInput {
  // Use a declared field order rather than object insertion order: receipt-only
  // recovery can reconstruct an otherwise identical envelope in a different
  // order, and its immutable payload fingerprint must remain stable.
  return {
    messageId: envelope.messageId,
    cardId: envelope.cardId,
    fromConversationId: envelope.fromConversationId,
    toConversationId: envelope.toConversationId,
    sentAt: envelope.sentAt,
    kind: envelope.kind,
    body: envelope.body,
    ...(envelope.summary === undefined ? {} : { summary: envelope.summary }),
    ...(envelope.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: envelope.replyToMessageId }),
    ...(envelope.delegationId === undefined
      ? {}
      : { delegationId: envelope.delegationId }),
    ...(envelope.requestFingerprint === undefined
      ? {}
      : { requestFingerprint: envelope.requestFingerprint }),
    fromRunId: envelope.fromRunId,
    fromSnapshot: envelope.fromSnapshot,
    toSnapshot: envelope.toSnapshot,
  };
}

export function inboxEnvelopePayloadFingerprint(
  envelope: InboxEnvelope,
): string {
  return createHash("sha256")
    .update(JSON.stringify(immutablePayload(envelope)), "utf8")
    .digest("hex");
}

function payloadsEqual(
  first: InboxEnvelope,
  second: InboxEnvelope,
): boolean {
  return (
    JSON.stringify(immutablePayload(first))
    === JSON.stringify(immutablePayload(second))
  );
}

async function assertOwnedDirectory(path: string): Promise<Stats> {
  const lexicalPath = resolve(path);
  const information = await lstat(lexicalPath);
  if (information.isSymbolicLink()) {
    throw new Error(
      `Inbox directory must not be a symbolic link or junction: ${lexicalPath}`,
    );
  }
  if (!information.isDirectory()) {
    throw new Error(`Inbox path is not a directory: ${lexicalPath}`);
  }
  const canonicalPath = await realpath(lexicalPath);
  if (!pathsAreIdentical(canonicalPath, lexicalPath)) {
    throw new Error(
      `Inbox directory resolves outside its project-owned path: ${lexicalPath} -> ${canonicalPath}`,
    );
  }
  return information;
}

async function assertOwnedFile(
  directory: string,
  path: string,
): Promise<Stats> {
  const lexicalPath = resolve(path);
  if (
    !pathsAreIdentical(dirname(lexicalPath), directory)
  ) {
    throw new Error(
      `Inbox entry is outside its project-owned directory: ${lexicalPath}`,
    );
  }
  const information = await lstat(lexicalPath);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(
      `Inbox entry must be a regular project-owned file: ${lexicalPath}`,
    );
  }
  const canonicalPath = await realpath(lexicalPath);
  if (!pathsAreIdentical(canonicalPath, lexicalPath)) {
    throw new Error(
      `Inbox entry resolves outside its project-owned path: ${lexicalPath} -> ${canonicalPath}`,
    );
  }
  return information;
}

async function readOwnedFile(
  directory: string,
  path: string,
  expected: Stats,
): Promise<string> {
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!statsAreIdentical(expected, opened)) {
      throw new Error(`Inbox entry changed while scanning: ${path}`);
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const afterRead = await handle.stat();
    const current = await assertOwnedFile(directory, path);
    if (
      !statsAreIdentical(expected, afterRead)
      || !statsAreIdentical(expected, current)
    ) {
      throw new Error(`Inbox entry changed while scanning: ${path}`);
    }
    return raw;
  } finally {
    await handle.close();
  }
}

export function parseInboxEnvelope(value: unknown): InboxEnvelope {
  const raw = envelopeSchema.parse(value);
  if (Buffer.byteLength(raw.body, "utf8") > MAX_CONVERSATION_BODY_BYTES) {
    throw new Error(
      `body exceeds ${MAX_CONVERSATION_BODY_BYTES} UTF-8 bytes`,
    );
  }
  if (raw.body.trim().length === 0) {
    throw new Error("body must not be blank");
  }
  if (
    (raw.state === "processing")
    !== (raw.processingRunId !== undefined)
  ) {
    throw new Error(
      "processingRunId must be present exactly when state is processing",
    );
  }
  if (
    raw.state !== "processing"
    && (
      raw.processingDelivery !== undefined
      || raw.waitedByRunId !== undefined
    )
  ) {
    throw new Error(
      "processingDelivery and waitedByRunId are only valid while processing",
    );
  }
  if (
    raw.waitedByRunId !== undefined
    && raw.waitedByRunId !== raw.processingRunId
  ) {
    throw new Error(
      "waitedByRunId must match the exact processingRunId",
    );
  }
  if (
    raw.kind !== "message"
    && raw.delegationId === undefined
  ) {
    throw new Error(`delegationId is required for kind ${raw.kind}`);
  }
  const fromSnapshot = parseConversationReferenceSnapshot(
    raw.fromSnapshot,
  );
  const toSnapshot = parseConversationReferenceSnapshot(raw.toSnapshot);
  if (fromSnapshot.conversationId !== raw.fromConversationId) {
    throw new Error(
      "fromSnapshot identity does not match fromConversationId",
    );
  }
  if (toSnapshot.conversationId !== raw.toConversationId) {
    throw new Error(
      "toSnapshot identity does not match toConversationId",
    );
  }

  return {
    version: INBOX_ENVELOPE_VERSION,
    messageId: raw.messageId,
    cardId: raw.cardId,
    fromConversationId: raw.fromConversationId,
    toConversationId: raw.toConversationId,
    sentAt: raw.sentAt,
    kind: raw.kind,
    body: raw.body,
    ...(raw.summary === undefined ? {} : { summary: raw.summary }),
    ...(raw.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: raw.replyToMessageId }),
    ...(raw.delegationId === undefined
      ? {}
      : { delegationId: raw.delegationId }),
    ...(raw.requestFingerprint === undefined
      ? {}
      : { requestFingerprint: raw.requestFingerprint }),
    fromRunId: raw.fromRunId,
    fromSnapshot,
    toSnapshot,
    state: raw.state,
    ...(raw.processingRunId === undefined
      ? {}
      : { processingRunId: raw.processingRunId }),
    ...(raw.processingDelivery === undefined
      ? {}
      : { processingDelivery: raw.processingDelivery }),
    ...(raw.waitedByRunId === undefined
      ? {}
      : { waitedByRunId: raw.waitedByRunId }),
  };
}

export function createInboxEnvelope(
  input: InboxEnvelopeInput,
  initialState: InboxStateUpdate = { state: "queued" },
): InboxEnvelope {
  const state = stateUpdateSchema.parse(initialState);
  return parseInboxEnvelope({
    version: INBOX_ENVELOPE_VERSION,
    ...input,
    ...state,
  });
}

function reservedEnvelopeBytes(envelope: InboxEnvelope): number {
  return Buffer.byteLength(serializeEnvelope(parseInboxEnvelope({
    ...immutablePayload(envelope),
    version: INBOX_ENVELOPE_VERSION,
    state: "processing",
    processingRunId: "ffffffff-ffff-8fff-bfff-ffffffffffff",
    processingDelivery: "steer",
    waitedByRunId: "ffffffff-ffff-8fff-bfff-ffffffffffff",
  })), "utf8");
}

export class ProjectInbox {
  private readonly directory: string;

  private readonly operations = new SerialTaskQueue();

  private mutationRevision = 0;

  private constructor(directory: string) {
    this.directory = resolve(directory);
  }

  static async open(directory: string): Promise<ProjectInbox> {
    const inbox = new ProjectInbox(directory);
    await assertOwnedDirectory(dirname(inbox.directory));
    try {
      await mkdir(inbox.directory);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    await assertOwnedDirectory(inbox.directory);
    await inbox.scan();
    return inbox;
  }

  put(
    input: InboxEnvelopeInput,
    options: InboxPutOptions = {},
  ): Promise<InboxPutResult> {
    return this.runMutation(async () => {
      let outcome: InboxPutOutcome = "definitely_noncommitted";
      try {
        const requestedState = options.initialState === undefined
          ? undefined
          : stateUpdateSchema.parse(options.initialState);
        const envelope = createInboxEnvelope(input, requestedState);
        const scan = await this.scan();
        if (scan.tombstones.some(
          ({ tombstone }) =>
            tombstone.conversationId === envelope.toConversationId,
        )) {
          throw new Error(
            `Inbox target has been deleted: ${envelope.toConversationId}`,
          );
        }
        const existing = scan.envelopes.find(
          ({ envelope: candidate }) => candidate.messageId === envelope.messageId,
        );
        if (existing !== undefined) {
          if (!payloadsEqual(existing.envelope, envelope)) {
            throw new Error(
              `Inbox message conflict for messageId ${envelope.messageId}`,
            );
          }
          if (requestedState !== undefined) {
            outcome = "committed_or_unknown";
          }
          return {
            status: "existing",
            envelope: requestedState === undefined
              ? cloneEnvelope(existing.envelope)
              : await this.updateStoredState(scan, existing, requestedState),
          };
        }

        this.assertCapacityForCreate(scan, envelope);
        const path = this.pathForMessage(envelope.messageId);
        const serialized = serializeEnvelope(envelope);
        try {
          await this.writeNewAtomically(path, serialized);
          outcome = "committed_or_unknown";
        } catch (error) {
          if (
            error instanceof InboxFilePublishedError
            || isNodeError(error, "EEXIST")
          ) {
            outcome = "committed_or_unknown";
          }
          if (!isNodeError(error, "EEXIST")) throw error;
          const raced = await this.scan();
          const match = raced.envelopes.find(
            ({ envelope: candidate }) => candidate.messageId === envelope.messageId,
          );
          if (
            match === undefined
            || !payloadsEqual(match.envelope, envelope)
          ) {
            throw new Error(
              `Inbox message conflict for messageId ${envelope.messageId}`,
              { cause: error },
            );
          }
          return {
            status: "existing",
            envelope: requestedState === undefined
              ? cloneEnvelope(match.envelope)
              : await this.updateStoredState(raced, match, requestedState),
          };
        }
        const committed = await this.scan();
        if (committed.tombstones.some(
          ({ tombstone }) =>
            tombstone.conversationId === envelope.toConversationId,
        )) {
          const pending = committed.envelopes.find(
            ({ envelope: candidate }) => candidate.messageId === envelope.messageId,
          );
          if (pending !== undefined) {
            await this.deleteStoredFile(pending);
          }
          throw new Error(
            `Inbox target has been deleted: ${envelope.toConversationId}`,
          );
        }
        return {
          status: "created",
          envelope: cloneEnvelope(envelope),
        };
      } catch (error) {
        throw new InboxPutOperationError(outcome, error);
      }
    });
  }

  list(options: InboxListOptions = {}): Promise<InboxEnvelope[]> {
    return this.operations.run(async () => {
      const filter = listOptionsSchema.parse(options);
      return this.listFromScan(await this.scan(), filter);
    });
  }

  async withListSnapshot<T>(
    work: (
      list: (options?: InboxListOptions) => Promise<InboxEnvelope[]>,
    ) => Promise<T> | T,
  ): Promise<T> {
    let active = true;
    let snapshot: InboxListSnapshot | undefined;
    const list = (options: InboxListOptions = {}) => this.operations.run(async () => {
      if (!active) {
        throw new Error("Inbox list snapshot is no longer active");
      }
      const filter = listOptionsSchema.parse(options);
      if (
        snapshot !== undefined
        && snapshot.mutationRevision === this.mutationRevision
        && await this.snapshotIsCurrent(snapshot.scan)
      ) {
        return this.listFromScan(snapshot.scan, filter);
      }
      const scan = await this.scan();
      snapshot = { scan, mutationRevision: this.mutationRevision };
      return this.listFromScan(scan, filter);
    });
    try {
      return await work(list);
    } finally {
      active = false;
      snapshot = undefined;
    }
  }

  listDeletedTargets(): Promise<string[]> {
    return this.operations.run(async () => {
      const scan = await this.scan();
      return scan.tombstones
        .map(({ tombstone }) => tombstone.conversationId)
        .sort();
    });
  }

  get(messageId: string): Promise<InboxEnvelope | undefined> {
    return this.operations.run(async () => {
      uuidSchema("messageId").parse(messageId);
      const scan = await this.scan();
      const match = scan.envelopes.find(
        ({ envelope }) => envelope.messageId === messageId,
      );
      return match === undefined
        ? undefined
        : cloneEnvelope(match.envelope);
    });
  }

  updateState(
    messageId: string,
    update: InboxStateUpdate,
  ): Promise<InboxEnvelope> {
    return this.runMutation(async () => {
      uuidSchema("messageId").parse(messageId);
      const state = stateUpdateSchema.parse(update);
      const scan = await this.scan();
      const match = scan.envelopes.find(
        ({ envelope }) => envelope.messageId === messageId,
      );
      if (match === undefined) {
        throw new Error(`Inbox message not found: ${messageId}`);
      }
      return this.updateStoredState(scan, match, state);
    });
  }

  delete(messageId: string): Promise<boolean> {
    return this.runMutation(async () => {
      uuidSchema("messageId").parse(messageId);
      const scan = await this.scan();
      const match = scan.envelopes.find(
        ({ envelope }) => envelope.messageId === messageId,
      );
      if (match === undefined) return false;
      await this.deleteStoredFile(match);
      return true;
    });
  }

  tombstoneTarget(
    conversationId: string,
    deletedAt = new Date().toISOString(),
  ): Promise<number> {
    return this.runMutation(async () => {
      conversationIdSchema("conversationId").parse(conversationId);
      canonicalTimestampSchema("deletedAt").parse(deletedAt);
      const scan = await this.persistTargetTombstone(
        conversationId,
        deletedAt,
      );

      const pending = scan.envelopes.filter(
        ({ envelope }) =>
          envelope.toConversationId === conversationId,
      );
      for (const envelope of pending) {
        await this.deleteStoredFile(envelope);
      }
      return pending.length;
    });
  }

  markTargetDeleted(
    conversationId: string,
    deletedAt = new Date().toISOString(),
  ): Promise<void> {
    return this.runMutation(async () => {
      conversationIdSchema("conversationId").parse(conversationId);
      canonicalTimestampSchema("deletedAt").parse(deletedAt);
      await this.persistTargetTombstone(conversationId, deletedAt);
    });
  }

  clearTargetTombstone(conversationId: string): Promise<boolean> {
    return this.runMutation(async () => {
      conversationIdSchema("conversationId").parse(conversationId);
      const scan = await this.scan();
      const existing = scan.tombstones.find(
        ({ tombstone }) =>
          tombstone.conversationId === conversationId,
      );
      if (existing === undefined) return false;
      if (scan.envelopes.some(
        ({ envelope }) =>
          envelope.toConversationId === conversationId,
      )) {
        throw new Error(
          `Cannot clear inbox target tombstone with pending messages: ${conversationId}`,
        );
      }
      await this.deleteStoredFile(existing);
      return true;
    });
  }

  /**
   * Captures one stable inbox view for a frozen delete set, then publishes all
   * missing durable target fences before returning any pending sidecars.
   */
  beginTargetDeletionBatch(
    conversationIds: readonly string[],
    deletedAt = new Date().toISOString(),
  ): Promise<InboxTargetDeletionBatch> {
    return this.runMutation(async () => {
      const uniqueConversationIds = [...new Set(conversationIds)];
      if (uniqueConversationIds.length === 0) {
        throw new Error("At least one inbox target is required");
      }
      for (const conversationId of uniqueConversationIds) {
        conversationIdSchema("conversationId").parse(conversationId);
      }
      canonicalTimestampSchema("deletedAt").parse(deletedAt);

      const initial = await this.scan();
      const existing = new Map(initial.tombstones.map((stored) => [
        stored.tombstone.conversationId,
        stored,
      ]));
      const missingConversationIds = uniqueConversationIds.filter(
        (conversationId) => !existing.has(conversationId),
      );
      const serializedTombstones = missingConversationIds.map(
        (conversationId) => serializeTargetTombstone({
          version: INBOX_TARGET_TOMBSTONE_VERSION,
          conversationId,
          deletedAt,
        }),
      );
      if (
        initial.tombstones.length + missingConversationIds.length
        > MAX_INBOX_TOMBSTONES_PER_PROJECT
      ) {
        throw new Error(
          `Inbox target tombstone limit exceeded: ${MAX_INBOX_TOMBSTONES_PER_PROJECT}`,
        );
      }
      const addedBytes = serializedTombstones.reduce(
        (total, serialized) => total + Buffer.byteLength(serialized, "utf8"),
        0,
      );
      if (
        initial.tombstoneBytes + addedBytes
        > MAX_INBOX_TOMBSTONE_TOTAL_BYTES
      ) {
        throw new Error(
          `Inbox tombstone byte limit exceeded: ${MAX_INBOX_TOMBSTONE_TOTAL_BYTES}`,
        );
      }

      // A failed batch must retain only its own fences. Unrelated durable
      // tombstones are independently recoverable and must not be adopted by
      // this caller's reservation/error path.
      const durableConversationIds = new Set(uniqueConversationIds.filter(
        (conversationId) => existing.has(conversationId),
      ));
      for (let index = 0; index < missingConversationIds.length; index += 1) {
        const conversationId = missingConversationIds[index]!;
        try {
          await this.writeNewAtomically(
            this.pathForTargetTombstone(conversationId),
            serializedTombstones[index]!,
          );
          durableConversationIds.add(conversationId);
        } catch (error) {
          // EEXIST is also publication-ambiguous: a concurrent writer may
          // have created this exact target fence. Keep the reservation until a
          // later stable census can distinguish it from a failed link.
          const uncertainConversationIds = (
            error instanceof InboxFilePublishedError || isNodeError(error, "EEXIST")
          )
            ? [conversationId]
            : [];
          if (uncertainConversationIds.length > 0) {
            durableConversationIds.add(conversationId);
          }
          if (durableConversationIds.size > 0) {
            throw new InboxTargetTombstoneBatchError(
              [...durableConversationIds].sort(),
              uncertainConversationIds,
              error,
            );
          }
          throw error;
        }
      }

      let committed: InboxScan;
      try {
        committed = await this.scan();
      } catch (error) {
        throw new InboxTargetTombstoneBatchError(
          uniqueConversationIds,
          uniqueConversationIds,
          error,
        );
      }
      const tombstoneFiles = uniqueConversationIds.map((conversationId) =>
        committed.tombstones.find(
          ({ tombstone }) => tombstone.conversationId === conversationId,
        )
      );
      if (tombstoneFiles.some((stored) => stored === undefined)) {
        throw new InboxTargetTombstoneBatchError(
          uniqueConversationIds,
          uniqueConversationIds,
          new Error("Inbox target tombstone was not persisted"),
        );
      }
      const targetIds = new Set(uniqueConversationIds);
      const pendingFiles = committed.envelopes.filter(({ envelope }) =>
        targetIds.has(envelope.toConversationId)
      );
      const batch: CapturedInboxTargetDeletionBatch = {
        owner: this,
        conversationIds: Object.freeze([...uniqueConversationIds]),
        pending: Object.freeze(pendingFiles.map(({ envelope }) =>
          cloneEnvelope(envelope)
        )),
        pendingFiles: Object.freeze([...pendingFiles]),
        tombstoneFiles: Object.freeze(
          tombstoneFiles as StoredTargetTombstone[],
        ),
      };
      return batch;
    });
  }

  /** Deletes only sidecars captured by beginTargetDeletionBatch(). */
  deleteCapturedTargetMessages(batch: InboxTargetDeletionBatch): Promise<void> {
    return this.runMutation(async () => {
      const captured = this.requireCapturedTargetDeletionBatch(batch);
      const scan = await this.scan();
      this.assertCapturedTargetTombstones(captured, scan);
      const targetIds = new Set(captured.conversationIds);
      const currentPending = scan.envelopes.filter(({ envelope }) =>
        targetIds.has(envelope.toConversationId)
      );
      this.assertCapturedPendingMessages(captured, currentPending);
      for (const stored of captured.pendingFiles) {
        await this.deleteStoredFile(stored);
      }
    });
  }

  /** Clears only the exact durable fences captured by beginTargetDeletionBatch(). */
  clearTargetDeletionBatch(batch: InboxTargetDeletionBatch): Promise<void> {
    return this.runMutation(async () => {
      const captured = this.requireCapturedTargetDeletionBatch(batch);
      const scan = await this.scan();
      this.assertCapturedTargetTombstones(captured, scan);
      const targetIds = new Set(captured.conversationIds);
      if (scan.envelopes.some(({ envelope }) =>
        targetIds.has(envelope.toConversationId)
      )) {
        throw new Error(
          "Cannot clear inbox target tombstones with pending messages",
        );
      }
      // The coordinator publishes root-first and clears root-last, keeping a
      // recoverable root intent until every descendant fence is gone. A
      // returned deleteStoredFile() is the only proof an individual fence was
      // fully removed; preserve that exact receipt if a later clear fails.
      const clearedConversationIds: string[] = [];
      for (const stored of [...captured.tombstoneFiles].reverse()) {
        try {
          await this.deleteStoredFile(stored);
          clearedConversationIds.push(stored.tombstone.conversationId);
        } catch (error) {
          throw new InboxTargetTombstoneBatchClearError(
            clearedConversationIds,
            error,
          );
        }
      }
    });
  }

  pruneCompletedTargetTombstones(
    existingConversationIds: ReadonlySet<string>,
  ): Promise<number> {
    return this.runMutation(async () => {
      const scan = await this.scan();
      let removed = 0;
      for (const existing of scan.tombstones) {
        const conversationId = existing.tombstone.conversationId;
        if (existingConversationIds.has(conversationId)) continue;
        if (scan.envelopes.some(
          ({ envelope }) =>
            envelope.toConversationId === conversationId,
        )) {
          throw new Error(
            `Deleted inbox target still has pending messages: ${conversationId}`,
          );
        }
        await this.deleteStoredFile(existing);
        removed++;
      }
      return removed;
    });
  }

  private runMutation<T>(
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return this.operations.run(async () => {
      try {
        return await operation();
      } finally {
        this.mutationRevision++;
      }
    });
  }

  private listFromScan(
    scan: InboxScan,
    filter: InboxListOptions,
  ): InboxEnvelope[] {
    return scan.envelopes
      .map(({ envelope }) => envelope)
      .filter((envelope) =>
        filter.toConversationId === undefined
        || envelope.toConversationId === filter.toConversationId
      )
      .sort((first, second) => {
        const bySentAt = Date.parse(first.sentAt) - Date.parse(second.sentAt);
        if (bySentAt !== 0) return bySentAt;
        return first.messageId.localeCompare(second.messageId);
      })
      .map(cloneEnvelope);
  }

  private async snapshotIsCurrent(scan: InboxScan): Promise<boolean> {
    const directoryBefore = await assertOwnedDirectory(this.directory);
    if (!snapshotStatsAreIdentical(scan.directoryInformation, directoryBefore)) {
      return false;
    }
    const expectedNames = [
      ...scan.envelopes.map(({ path }) => basename(path)),
      ...scan.tombstones.map(({ path }) => basename(path)),
    ].sort();
    const namesBefore = (await readdir(this.directory)).sort();
    if (
      namesBefore.length !== expectedNames.length
      || namesBefore.some((name, index) => name !== expectedNames[index])
    ) {
      return false;
    }
    for (const stored of [...scan.envelopes, ...scan.tombstones]) {
      const current = await assertOwnedFile(this.directory, stored.path);
      if (!snapshotStatsAreIdentical(stored.information, current)) return false;
    }
    const namesAfter = (await readdir(this.directory)).sort();
    if (
      namesAfter.length !== expectedNames.length
      || namesAfter.some((name, index) => name !== expectedNames[index])
    ) {
      return false;
    }
    const directoryAfter = await assertOwnedDirectory(this.directory);
    return snapshotStatsAreIdentical(scan.directoryInformation, directoryAfter);
  }

  private requireCapturedTargetDeletionBatch(
    batch: InboxTargetDeletionBatch,
  ): CapturedInboxTargetDeletionBatch {
    const captured = batch as CapturedInboxTargetDeletionBatch;
    if (
      captured.owner !== this
      || !Array.isArray(captured.pendingFiles)
      || !Array.isArray(captured.tombstoneFiles)
    ) {
      throw new Error("Inbox target deletion batch does not belong to this inbox");
    }
    return captured;
  }

  private assertCapturedTargetTombstones(
    captured: CapturedInboxTargetDeletionBatch,
    scan: InboxScan,
  ): void {
    const currentByConversationId = new Map(scan.tombstones.map((stored) => [
      stored.tombstone.conversationId,
      stored,
    ]));
    for (const expected of captured.tombstoneFiles) {
      const current = currentByConversationId.get(
        expected.tombstone.conversationId,
      );
      if (
        current === undefined
        || !storedFilesAreIdentical(expected, current)
        || JSON.stringify(expected.tombstone) !== JSON.stringify(current.tombstone)
      ) {
        throw new Error(
          `Inbox target tombstone changed after deletion was fenced: ${expected.tombstone.conversationId}`,
        );
      }
    }
  }

  private assertCapturedPendingMessages(
    captured: CapturedInboxTargetDeletionBatch,
    currentPending: readonly StoredEnvelope[],
  ): void {
    if (currentPending.length !== captured.pendingFiles.length) {
      throw new Error("Inbox target messages changed after deletion was fenced");
    }
    const currentByMessageId = new Map(currentPending.map((stored) => [
      stored.envelope.messageId,
      stored,
    ]));
    for (const expected of captured.pendingFiles) {
      const current = currentByMessageId.get(expected.envelope.messageId);
      if (
        current === undefined
        || !storedFilesAreIdentical(expected, current)
        || JSON.stringify(expected.envelope) !== JSON.stringify(current.envelope)
      ) {
        throw new Error(
          `Inbox target message changed after deletion was fenced: ${expected.envelope.messageId}`,
        );
      }
    }
  }

  private async persistTargetTombstone(
    conversationId: string,
    deletedAt: string,
  ): Promise<InboxScan> {
    let scan = await this.scan();
    const existing = scan.tombstones.find(
      ({ tombstone }) =>
        tombstone.conversationId === conversationId,
    );
    if (existing !== undefined) return scan;
    if (
      scan.tombstones.length
      >= MAX_INBOX_TOMBSTONES_PER_PROJECT
    ) {
      throw new Error(
        `Inbox target tombstone limit exceeded: ${MAX_INBOX_TOMBSTONES_PER_PROJECT}`,
      );
    }
    const tombstone: InboxTargetTombstone = {
      version: INBOX_TARGET_TOMBSTONE_VERSION,
      conversationId,
      deletedAt,
    };
    const serialized = serializeTargetTombstone(tombstone);
    if (
      scan.tombstoneBytes
        + Buffer.byteLength(serialized, "utf8")
      > MAX_INBOX_TOMBSTONE_TOTAL_BYTES
    ) {
      throw new Error(
        `Inbox tombstone byte limit exceeded: ${MAX_INBOX_TOMBSTONE_TOTAL_BYTES}`,
      );
    }
    const path = this.pathForTargetTombstone(conversationId);
    let publicationSucceeded = false;
    let publicationWasAmbiguous = false;
    let ambiguousPublication: unknown;
    try {
      await this.writeNewAtomically(path, serialized);
      publicationSucceeded = true;
    } catch (error) {
      if (
        !(error instanceof InboxFilePublishedError)
        && !isNodeError(error, "EEXIST")
      ) {
        throw error;
      }
      // A completed link whose proof failed, or EEXIST, has no durable
      // meaning until a stable census observes its target.
      publicationWasAmbiguous = true;
      ambiguousPublication = error;
    }
    try {
      scan = await this.scan();
    } catch (error) {
      if (publicationSucceeded || publicationWasAmbiguous) {
        throw new InboxTargetTombstoneCommittedError(
          conversationId,
          error,
        );
      }
      throw error;
    }
    if (scan.tombstones.some(
      ({ tombstone: persisted }) =>
        persisted.conversationId === conversationId,
    )) {
      return scan;
    }
    // A stable census without the target is terminal evidence that no
    // deletion fence is currently durable. It is safe to release the warm
    // reservation rather than maroon it behind an ambiguous syscall error.
    throw new Error(
      `Inbox target tombstone was not persisted: ${conversationId}`,
      { cause: ambiguousPublication },
    );
  }

  private pathForMessage(messageId: string): string {
    return join(this.directory, `${messageId}.json`);
  }

  private pathForTargetTombstone(conversationId: string): string {
    return join(
      this.directory,
      `target-${targetIdentity(conversationId)}.tombstone.json`,
    );
  }

  private async scan(): Promise<InboxScan> {
    if (await this.recoverArtifacts()) {
      this.mutationRevision++;
    }
    const directoryBefore = await assertOwnedDirectory(this.directory);
    const namesBefore = (await readdir(this.directory)).sort();
    if (
      namesBefore.length
      > MAX_INBOX_MESSAGES_PER_PROJECT
        + MAX_INBOX_TOMBSTONES_PER_PROJECT
    ) {
      throw new Error(
        "Inbox project entry limit exceeded",
      );
    }

    const stored: StoredEnvelope[] = [];
    const tombstones: StoredTargetTombstone[] = [];
    let totalBytes = 0;
    let tombstoneBytes = 0;
    let reservedBytes = 0;
    const targetCounts = new Map<string, number>();
    for (const name of namesBefore) {
      const envelopeName = INBOX_FILE_PATTERN.exec(name);
      const tombstoneName = TARGET_TOMBSTONE_FILE_PATTERN.exec(name);
      if (envelopeName === null && tombstoneName === null) {
        throw new Error(`Invalid inbox entry name: ${name}`);
      }
      const path = join(this.directory, name);
      const information = await assertOwnedFile(this.directory, path);
      if (
        envelopeName !== null
        && information.size > MAX_INBOX_TOTAL_BYTES
      ) {
        throw new Error(
          `Inbox total byte limit exceeded: ${MAX_INBOX_TOTAL_BYTES}`,
        );
      }
      if (
        tombstoneName !== null
        && information.size > MAX_INBOX_TOMBSTONE_TOTAL_BYTES
      ) {
        throw new Error(
          `Inbox tombstone byte limit exceeded: ${MAX_INBOX_TOMBSTONE_TOTAL_BYTES}`,
        );
      }
      const raw = await readOwnedFile(this.directory, path, information);
      if (!raw.endsWith("\n")) {
        throw new Error(`Inbox entry must end with a newline: ${path}`);
      }

      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Inbox entry has invalid JSON: ${path}`, {
          cause: error,
        });
      }

      if (tombstoneName !== null) {
        let tombstone: InboxTargetTombstone;
        try {
          tombstone = parseTargetTombstone(value);
        } catch (error) {
          const detail = error instanceof Error
            ? error.message
            : String(error);
          throw new Error(
            `Invalid inbox target tombstone at ${path}: ${detail}`,
            { cause: error },
          );
        }
        if (
          targetIdentity(tombstone.conversationId)
          !== tombstoneName[1]
        ) {
          throw new Error(
            `Inbox tombstone filename identity does not match target ${tombstone.conversationId}: ${path}`,
          );
        }
        tombstones.push({ tombstone, path, information });
        tombstoneBytes += information.size;
        if (tombstoneBytes > MAX_INBOX_TOMBSTONE_TOTAL_BYTES) {
          throw new Error(
            `Inbox tombstone byte limit exceeded: ${MAX_INBOX_TOMBSTONE_TOTAL_BYTES}`,
          );
        }
        continue;
      }

      const messageId = envelopeName![1]!;
      let envelope: InboxEnvelope;
      try {
        envelope = parseInboxEnvelope(value);
      } catch (error) {
        const detail = error instanceof Error
          ? error.message
          : String(error);
        throw new Error(`Invalid inbox envelope at ${path}: ${detail}`, {
          cause: error,
        });
      }
      if (envelope.messageId !== messageId) {
        throw new Error(
          `Inbox filename identity does not match messageId ${envelope.messageId}: ${path}`,
        );
      }
      const targetCount =
        (targetCounts.get(envelope.toConversationId) ?? 0) + 1;
      if (targetCount > MAX_INBOX_MESSAGES_PER_TARGET) {
        throw new Error(
          `Inbox target message limit exceeded for ${envelope.toConversationId}: ${MAX_INBOX_MESSAGES_PER_TARGET}`,
        );
      }
      targetCounts.set(envelope.toConversationId, targetCount);
      totalBytes += information.size;
      if (totalBytes > MAX_INBOX_TOTAL_BYTES) {
        throw new Error(
          `Inbox total byte limit exceeded: ${MAX_INBOX_TOTAL_BYTES}`,
        );
      }
      reservedBytes += reservedEnvelopeBytes(envelope);
      stored.push({
        envelope,
        path,
        bytes: information.size,
        information,
      });
    }

    if (stored.length > MAX_INBOX_MESSAGES_PER_PROJECT) {
      throw new Error(
        `Inbox project message limit exceeded: ${MAX_INBOX_MESSAGES_PER_PROJECT}`,
      );
    }
    if (tombstones.length > MAX_INBOX_TOMBSTONES_PER_PROJECT) {
      throw new Error(
        `Inbox target tombstone limit exceeded: ${MAX_INBOX_TOMBSTONES_PER_PROJECT}`,
      );
    }

    const namesAfter = (await readdir(this.directory)).sort();
    if (
      namesAfter.length !== namesBefore.length
      || namesAfter.some((name, index) => name !== namesBefore[index])
    ) {
      throw new Error("Inbox directory changed while scanning");
    }
    const directoryAfter = await assertOwnedDirectory(this.directory);
    if (!snapshotStatsAreIdentical(directoryBefore, directoryAfter)) {
      throw new Error("Inbox directory changed while scanning");
    }
    return {
      directoryInformation: directoryAfter,
      envelopes: stored,
      tombstones,
      totalBytes,
      tombstoneBytes,
      reservedBytes,
    };
  }

  private async updateStoredState(
    scan: InboxScan,
    match: StoredEnvelope,
    state: InboxStateUpdate,
  ): Promise<InboxEnvelope> {
    const next = createInboxEnvelope(
      immutablePayload(match.envelope),
      state,
    );
    if (JSON.stringify(next) === JSON.stringify(match.envelope)) {
      return cloneEnvelope(match.envelope);
    }
    const serialized = serializeEnvelope(next);
    if (
      scan.totalBytes - match.bytes + Buffer.byteLength(serialized, "utf8")
      > MAX_INBOX_TOTAL_BYTES
    ) {
      throw new Error(
        `Inbox total byte limit exceeded: ${MAX_INBOX_TOTAL_BYTES}`,
      );
    }
    await this.replaceStoredFile(match, serialized);
    return cloneEnvelope(next);
  }

  private assertCapacityForCreate(
    scan: InboxScan,
    envelope: InboxEnvelope,
  ): void {
    const stored = scan.envelopes;
    if (stored.length >= MAX_INBOX_MESSAGES_PER_PROJECT) {
      throw new Error(
        `Inbox project message limit exceeded: ${MAX_INBOX_MESSAGES_PER_PROJECT}`,
      );
    }
    const targetCount = stored.filter(
      ({ envelope: existing }) =>
        existing.toConversationId === envelope.toConversationId,
    ).length;
    if (targetCount >= MAX_INBOX_MESSAGES_PER_TARGET) {
      throw new Error(
        `Inbox target message limit exceeded for ${envelope.toConversationId}: ${MAX_INBOX_MESSAGES_PER_TARGET}`,
      );
    }
    const reservedBytes = scan.reservedBytes + reservedEnvelopeBytes(envelope);
    if (reservedBytes > MAX_INBOX_TOTAL_BYTES) {
      throw new Error(
        `Inbox total byte limit exceeded: ${MAX_INBOX_TOTAL_BYTES}`,
      );
    }
  }

  private async recoverArtifacts(): Promise<boolean> {
    await assertOwnedDirectory(this.directory);
    const names = (await readdir(this.directory)).sort();
    if (
      names.length
      > MAX_INBOX_MESSAGES_PER_PROJECT + MAX_INBOX_TOMBSTONES_PER_PROJECT + 2
    ) {
      throw new Error("Inbox project entry limit exceeded");
    }

    const artifacts: InboxArtifact[] = [];
    for (const name of names) {
      const match = INBOX_ARTIFACT_PATTERN.exec(name);
      if (match === null) continue;
      const originalPath = join(this.directory, match[1]!);
      const path = join(this.directory, name);
      artifacts.push({
        originalPath,
        path,
        information: await assertOwnedFile(this.directory, path),
        operation: match[2]! as InboxMutationOperation,
        transactionId: match[3]!,
        stage: match[4]! as InboxArtifactStage,
      });
    }
    if (artifacts.length === 0) return false;

    const groups = new Map<string, InboxArtifact[]>();
    for (const artifact of artifacts) {
      const key = [
        artifact.originalPath,
        artifact.operation,
        artifact.transactionId,
      ].join("\u0000");
      const group = groups.get(key) ?? [];
      group.push(artifact);
      groups.set(key, group);
    }
    if (groups.size !== 1) {
      throw new Error("Inbox recovery found multiple mutation transactions");
    }
    const group = [...groups.values()][0]!;
    const temporary = group.filter(({ stage }) => stage === "tmp");
    const quarantine = group.filter(({ stage }) => stage === "quarantine");
    if (temporary.length > 1 || quarantine.length > 1) {
      throw new Error("Inbox recovery found duplicate mutation artifacts");
    }

    const operation = group[0]!.operation;
    const targetPath = group[0]!.originalPath;
    if (operation === "create") {
      if (temporary.length !== 1 || quarantine.length !== 0) {
        throw new Error("Invalid create mutation artifacts");
      }
      await this.recoverCreateArtifact(targetPath, temporary[0]!);
    } else if (operation === "replace") {
      await this.recoverReplaceArtifacts(
        targetPath,
        temporary[0],
        quarantine[0],
      );
    } else {
      if (temporary.length !== 0 || quarantine.length !== 1) {
        throw new Error("Invalid delete mutation artifacts");
      }
      await this.recoverDeleteArtifact(targetPath, quarantine[0]!);
    }

    const remaining = (await readdir(this.directory)).filter((name) =>
      INBOX_ARTIFACT_PATTERN.test(name),
    );
    if (remaining.length !== 0) {
      throw new Error("Inbox recovery could not clear mutation artifacts");
    }
    return true;
  }

  private async recoverCreateArtifact(
    targetPath: string,
    temporary: InboxArtifact,
  ): Promise<void> {
    const current = await this.ownedFileIfPresent(targetPath);
    if (
      current !== undefined
      && !statsAreIdentical(temporary.information, current)
    ) {
      throw new Error(
        `Inbox create artifact conflicts with published entry: ${targetPath}`,
      );
    }
    await this.unlinkVerified(temporary.path, temporary.information);
  }

  private async recoverReplaceArtifacts(
    targetPath: string,
    temporary: InboxArtifact | undefined,
    quarantine: InboxArtifact | undefined,
  ): Promise<void> {
    const current = await this.ownedFileIfPresent(targetPath);
    if (temporary !== undefined && quarantine !== undefined) {
      if (current === undefined) {
        if (statsAreIdentical(temporary.information, quarantine.information)) {
          throw new Error(
            `Inbox replace artifacts share an inode before publication: ${targetPath}`,
          );
        }
        await this.restoreArtifact(quarantine);
        await this.unlinkVerified(temporary.path, temporary.information);
        return;
      }
      const committed = statsAreIdentical(temporary.information, current)
        && !statsAreIdentical(quarantine.information, current);
      const rollbackRestored = statsAreIdentical(quarantine.information, current)
        && !statsAreIdentical(temporary.information, current);
      if (!committed && !rollbackRestored) {
        throw new Error(
          `Inbox replace artifacts conflict with published entry: ${targetPath}`,
        );
      }
      await this.unlinkVerified(quarantine.path, quarantine.information);
      await this.unlinkVerified(temporary.path, temporary.information);
      return;
    }
    if (temporary !== undefined) {
      if (current === undefined) {
        throw new Error(
          `Inbox replace temporary has no original entry: ${targetPath}`,
        );
      }
      await this.unlinkVerified(temporary.path, temporary.information);
      return;
    }
    if (quarantine !== undefined) {
      throw new Error(
        `Inbox replace quarantine has no matching temporary: ${targetPath}`,
      );
    }
    throw new Error("Invalid replace mutation artifacts");
  }

  private async recoverDeleteArtifact(
    targetPath: string,
    quarantine: InboxArtifact,
  ): Promise<void> {
    if (await this.ownedFileIfPresent(targetPath) !== undefined) {
      throw new Error(
        `Inbox delete quarantine conflicts with original entry: ${targetPath}`,
      );
    }
    await this.unlinkVerified(quarantine.path, quarantine.information);
  }

  private async restoreArtifact(artifact: InboxArtifact): Promise<void> {
    const current = await assertOwnedFile(this.directory, artifact.path);
    if (!statsAreIdentical(artifact.information, current)) {
      throw new Error(`Inbox recovery artifact changed: ${artifact.path}`);
    }
    if (await this.ownedFileIfPresent(artifact.originalPath) !== undefined) {
      throw new Error(
        `Inbox recovery target already exists: ${artifact.originalPath}`,
      );
    }
    await link(artifact.path, artifact.originalPath);
    const restored = await assertOwnedFile(this.directory, artifact.originalPath);
    if (!statsAreIdentical(current, restored)) {
      throw new Error(
        `Inbox recovery target changed while being restored: ${artifact.originalPath}`,
      );
    }
    await this.unlinkVerified(artifact.path, current);
  }

  private async ownedFileIfPresent(path: string): Promise<Stats | undefined> {
    try {
      return await assertOwnedFile(this.directory, path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async unlinkVerified(path: string, expected: Stats): Promise<void> {
    const current = await assertOwnedFile(this.directory, path);
    if (!statsAreIdentical(expected, current)) {
      throw new Error(`Inbox mutation artifact changed: ${path}`);
    }
    await unlink(path);
  }

  private async recoverMutationFailure(failure: unknown): Promise<void> {
    try {
      await this.recoverArtifacts();
    } catch (recoveryError) {
      const aggregate = new AggregateError(
        [failure, recoveryError],
        "Inbox mutation failed and recovery could not be completed",
      );
      if (failure instanceof InboxFilePublishedError) {
        throw new InboxFilePublishedError(failure.targetPath, aggregate);
      }
      if (failure instanceof InboxFileDeletedError) {
        throw new InboxFileDeletedError(failure.targetPath, aggregate);
      }
      throw aggregate;
    }
  }

  private async recoveryReachedPublishedFile(
    targetPath: string,
    expected: Stats,
    failure: InboxFilePublishedError,
  ): Promise<boolean> {
    try {
      const current = await this.ownedFileIfPresent(targetPath);
      return current !== undefined && statsAreIdentical(expected, current);
    } catch (proofError) {
      throw new InboxFilePublishedError(targetPath, new AggregateError(
        [failure, proofError],
        "Inbox publication recovery outcome could not be proved",
      ));
    }
  }

  private async recoveryReachedAbsentPath(
    targetPath: string,
    failure: InboxFileDeletedError,
  ): Promise<boolean> {
    try {
      return await this.ownedFileIfPresent(targetPath) === undefined;
    } catch (proofError) {
      throw new InboxFileDeletedError(targetPath, new AggregateError(
        [failure, proofError],
        "Inbox deletion recovery outcome could not be proved",
      ));
    }
  }

  private async writeNewAtomically(
    targetPath: string,
    content: string,
  ): Promise<void> {
    let staged: StagedInboxFile | undefined;
    let published = false;
    try {
      staged = await this.stageNewFile(targetPath, content, "create");
      await this.publishStagedFile(staged);
      published = true;
      await this.unlinkVerified(staged.temporaryPath, staged.information);
    } catch (error) {
      const failure = error instanceof InboxFilePublishedError
        ? error
        : published && staged !== undefined
        ? new InboxFilePublishedError(targetPath, error)
        : undefined;
      if (failure === undefined) {
        await this.recoverMutationFailure(error);
        throw error;
      }
      await this.recoverMutationFailure(failure);
      if (staged !== undefined && await this.recoveryReachedPublishedFile(
        targetPath,
        staged.information,
        failure,
      )) {
        return;
      }
      throw failure;
    }
  }

  private async replaceStoredFile(
    stored: StoredInboxFile,
    content: string,
  ): Promise<void> {
    let staged: StagedInboxFile | undefined;
    let published = false;
    try {
      staged = await this.stageNewFile(stored.path, content, "replace");
      const quarantined = await this.quarantineStoredFile(
        stored,
        "replace",
        staged.transactionId,
      );
      await this.publishStagedFile(staged);
      published = true;
      await this.unlinkVerified(
        quarantined.quarantinePath,
        quarantined.information,
      );
      await this.unlinkVerified(staged.temporaryPath, staged.information);
    } catch (error) {
      const failure = error instanceof InboxFilePublishedError
        ? error
        : published && staged !== undefined
        ? new InboxFilePublishedError(stored.path, error)
        : undefined;
      if (failure === undefined) {
        await this.recoverMutationFailure(error);
        throw error;
      }
      await this.recoverMutationFailure(failure);
      if (staged !== undefined && await this.recoveryReachedPublishedFile(
        stored.path,
        staged.information,
        failure,
      )) {
        return;
      }
      throw failure;
    }
  }

  private async deleteStoredFile(stored: StoredInboxFile): Promise<void> {
    let deleted = false;
    try {
      const quarantined = await this.quarantineStoredFile(
        stored,
        "delete",
        randomUUID(),
      );
      deleted = true;
      await this.unlinkVerified(
        quarantined.quarantinePath,
        quarantined.information,
      );
      await this.assertOriginalPathAbsent(quarantined.originalPath);
    } catch (error) {
      const failure = error instanceof InboxFileDeletedError
        ? error
        : deleted
        ? new InboxFileDeletedError(stored.path, error)
        : undefined;
      if (failure === undefined) {
        await this.recoverMutationFailure(error);
        throw error;
      }
      await this.recoverMutationFailure(failure);
      if (await this.recoveryReachedAbsentPath(stored.path, failure)) return;
      throw failure;
    }
  }

  private async stageNewFile(
    targetPath: string,
    content: string,
    operation: "create" | "replace",
  ): Promise<StagedInboxFile> {
    const transactionId = randomUUID();
    const temporaryPath = this.artifactPath(
      targetPath,
      operation,
      transactionId,
      "tmp",
    );
    await assertOwnedDirectory(this.directory);
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
    });
    const information = await assertOwnedFile(this.directory, temporaryPath);
    return {
      originalPath: targetPath,
      temporaryPath,
      information,
      operation,
      transactionId,
    };
  }

  private async publishStagedFile(staged: StagedInboxFile): Promise<void> {
    let linked = false;
    try {
      await link(staged.temporaryPath, staged.originalPath);
      linked = true;
      const current = await assertOwnedFile(this.directory, staged.originalPath);
      if (!statsAreIdentical(staged.information, current)) {
        throw new Error(
          `Inbox entry changed while being published: ${staged.originalPath}`,
        );
      }
    } catch (error) {
      if (linked) {
        throw new InboxFilePublishedError(staged.originalPath, error);
      }
      try {
        const current = await this.ownedFileIfPresent(staged.originalPath);
        if (
          current !== undefined
          && statsAreIdentical(staged.information, current)
        ) {
          throw new InboxFilePublishedError(staged.originalPath, error);
        }
      } catch (proofError) {
        if (proofError instanceof InboxFilePublishedError) throw proofError;
        throw new InboxFilePublishedError(staged.originalPath, new AggregateError(
          [error, proofError],
          "Inbox publication outcome could not be proved",
        ));
      }
      throw error;
    }
  }

  private async quarantineStoredFile(
    stored: StoredInboxFile,
    operation: "replace" | "delete",
    transactionId: string,
  ): Promise<QuarantinedInboxFile> {
    const quarantinePath = this.artifactPath(
      stored.path,
      operation,
      transactionId,
      "quarantine",
    );
    await assertOwnedDirectory(this.directory);
    let renamed = false;
    let quarantined: QuarantinedInboxFile | undefined;
    try {
      await rename(stored.path, quarantinePath);
      renamed = true;
      const information = await assertOwnedFile(this.directory, quarantinePath);
      quarantined = {
        originalPath: stored.path,
        quarantinePath,
        information,
        operation,
        transactionId,
      };
      if (!statsAreIdentical(stored.information, information)) {
        throw new Error(`Inbox entry changed before mutation: ${stored.path}`);
      }
      return quarantined;
    } catch (error) {
      if (quarantined !== undefined) {
        try {
          await this.restoreArtifact({
            originalPath: quarantined.originalPath,
            path: quarantined.quarantinePath,
            information: quarantined.information,
            operation: quarantined.operation,
            transactionId: quarantined.transactionId,
            stage: "quarantine",
          });
        } catch (recoveryError) {
          throw new InboxFileDeletedError(stored.path, new AggregateError(
            [error, recoveryError],
            "Inbox quarantine recovery could not be completed",
          ));
        }
        throw error;
      }
      if (renamed) {
        throw new InboxFileDeletedError(stored.path, error);
      }
      throw error;
    }
  }

  private async assertOriginalPathAbsent(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    throw new Error(`Inbox entry reappeared while it was being deleted: ${path}`);
  }

  private artifactPath(
    targetPath: string,
    operation: InboxMutationOperation,
    transactionId: string,
    stage: InboxArtifactStage,
  ): string {
    if (!pathsAreIdentical(dirname(resolve(targetPath)), this.directory)) {
      throw new Error(`Inbox mutation target is outside its directory: ${targetPath}`);
    }
    return join(
      this.directory,
      `.${basename(targetPath)}.${operation}.${transactionId}.${stage}`,
    );
  }
}
