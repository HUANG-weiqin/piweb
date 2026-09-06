import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
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
    "delegation_result",
    "delegation_failure",
  ]),
  body: z.string(),
  replyToMessageId: uuidSchema("replyToMessageId").optional(),
  delegationId: uuidSchema("delegationId").optional(),
  requestFingerprint: z.string().regex(
    SHA256_HEX_PATTERN,
    "requestFingerprint must be a lowercase SHA-256 hex digest",
  ).optional(),
  fromRunId: uuidSchema("fromRunId"),
  temporaryReturnAssignment: z.object({
    initialRunId: uuidSchema("temporaryReturnAssignment.initialRunId"),
    callerRunId: uuidSchema("temporaryReturnAssignment.callerRunId"),
    assignedAt: canonicalTimestampSchema("temporaryReturnAssignment.assignedAt"),
  }).strict().optional(),
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
  replyToMessageId?: string;
  delegationId?: string;
  requestFingerprint?: string;
  /** Frozen source run correlation used by durable wait rendezvous. */
  fromRunId: string;
  /** Atomic proof that this message owned a temporary caller's exact wait. */
  temporaryReturnAssignment?: {
    initialRunId: string;
    callerRunId: string;
    assignedAt: string;
  };
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

export interface InboxListOptions {
  toConversationId?: string;
}

interface StoredEnvelope {
  envelope: InboxEnvelope;
  path: string;
  bytes: number;
  information: Stats;
}

interface InboxTargetTombstone {
  version: typeof INBOX_TARGET_TOMBSTONE_VERSION;
  conversationId: string;
  deletedAt: string;
}

interface StoredTargetTombstone {
  tombstone: InboxTargetTombstone;
  path: string;
}

interface InboxScan {
  envelopes: StoredEnvelope[];
  tombstones: StoredTargetTombstone[];
  totalBytes: number;
  tombstoneBytes: number;
  reservedBytes: number;
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

function cloneEnvelope(envelope: InboxEnvelope): InboxEnvelope {
  return {
    ...envelope,
    ...(envelope.temporaryReturnAssignment === undefined
      ? {}
      : {
          temporaryReturnAssignment: {
            ...envelope.temporaryReturnAssignment,
          },
        }),
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
  const {
    version: _version,
    state: _state,
    processingRunId: _processingRunId,
    processingDelivery: _processingDelivery,
    waitedByRunId: _waitedByRunId,
    ...payload
  } = envelope;
  return payload;
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

async function assertOwnedDirectory(path: string): Promise<void> {
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
  if (
    raw.temporaryReturnAssignment !== undefined
    && (
      raw.kind !== "message"
      || raw.fromRunId !== raw.temporaryReturnAssignment.initialRunId
    )
  ) {
    throw new Error(
      "temporaryReturnAssignment requires a message from its exact initial run",
    );
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
    ...(raw.temporaryReturnAssignment === undefined
      ? {}
      : {
          temporaryReturnAssignment: {
            ...raw.temporaryReturnAssignment,
          },
        }),
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
    return this.operations.run(async () => {
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
      } catch (error) {
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
          await this.assertStoredFileUnchanged(pending);
          await unlink(pending.path);
        }
        throw new Error(
          `Inbox target has been deleted: ${envelope.toConversationId}`,
        );
      }
      return {
        status: "created",
        envelope: cloneEnvelope(envelope),
      };
    });
  }

  list(options: InboxListOptions = {}): Promise<InboxEnvelope[]> {
    return this.operations.run(async () => {
      const filter = listOptionsSchema.parse(options);
      const scan = await this.scan();
      return scan.envelopes
        .map(({ envelope }) => envelope)
        .filter((envelope) =>
          filter.toConversationId === undefined
          || envelope.toConversationId === filter.toConversationId
        )
        .sort((first, second) => {
          const bySentAt =
            Date.parse(first.sentAt) - Date.parse(second.sentAt);
          if (bySentAt !== 0) return bySentAt;
          return first.messageId.localeCompare(second.messageId);
        })
        .map(cloneEnvelope);
    });
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
    return this.operations.run(async () => {
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
    return this.operations.run(async () => {
      uuidSchema("messageId").parse(messageId);
      const scan = await this.scan();
      const match = scan.envelopes.find(
        ({ envelope }) => envelope.messageId === messageId,
      );
      if (match === undefined) return false;
      await this.assertStoredFileUnchanged(match);
      await unlink(match.path);
      return true;
    });
  }

  tombstoneTarget(
    conversationId: string,
    deletedAt = new Date().toISOString(),
  ): Promise<number> {
    return this.operations.run(async () => {
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
        await this.assertStoredFileUnchanged(envelope);
        await unlink(envelope.path);
      }
      return pending.length;
    });
  }

  markTargetDeleted(
    conversationId: string,
    deletedAt = new Date().toISOString(),
  ): Promise<void> {
    return this.operations.run(async () => {
      conversationIdSchema("conversationId").parse(conversationId);
      canonicalTimestampSchema("deletedAt").parse(deletedAt);
      await this.persistTargetTombstone(conversationId, deletedAt);
    });
  }

  clearTargetTombstone(conversationId: string): Promise<boolean> {
    return this.operations.run(async () => {
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
      await assertOwnedFile(this.directory, existing.path);
      await unlink(existing.path);
      return true;
    });
  }

  pruneCompletedTargetTombstones(
    existingConversationIds: ReadonlySet<string>,
  ): Promise<number> {
    return this.operations.run(async () => {
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
        await assertOwnedFile(this.directory, existing.path);
        await unlink(existing.path);
        removed++;
      }
      return removed;
    });
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
    try {
      await this.writeNewAtomically(path, serialized);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    scan = await this.scan();
    if (!scan.tombstones.some(
      ({ tombstone: persisted }) =>
        persisted.conversationId === conversationId,
    )) {
      throw new Error(
        `Inbox target tombstone was not persisted: ${conversationId}`,
      );
    }
    return scan;
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
    await assertOwnedDirectory(this.directory);
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
      const raw = await readFile(path, "utf8");
      const informationAfterRead = await lstat(path);
      if (!statsAreIdentical(information, informationAfterRead)) {
        throw new Error(`Inbox entry changed while scanning: ${path}`);
      }
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
        tombstones.push({ tombstone, path });
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
    await assertOwnedDirectory(this.directory);
    return {
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
    await this.assertStoredFileUnchanged(match);
    await this.replaceAtomically(match.path, serialized);
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

  private async writeNewAtomically(
    targetPath: string,
    content: string,
  ): Promise<void> {
    const temporaryPath = this.temporaryPath(targetPath);
    try {
      await writeFile(temporaryPath, content, {
        encoding: "utf8",
        flag: "wx",
      });
      await link(temporaryPath, targetPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async replaceAtomically(
    targetPath: string,
    content: string,
  ): Promise<void> {
    const temporaryPath = this.temporaryPath(targetPath);
    try {
      await writeFile(temporaryPath, content, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private temporaryPath(targetPath: string): string {
    return join(
      dirname(this.directory),
      `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
  }

  private async assertStoredFileUnchanged(
    stored: StoredEnvelope,
  ): Promise<void> {
    const current = await assertOwnedFile(
      this.directory,
      stored.path,
    );
    if (!statsAreIdentical(stored.information, current)) {
      throw new Error(
        `Inbox entry changed before mutation: ${stored.path}`,
      );
    }
  }
}
