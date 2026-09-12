import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  ConversationSummary,
  PeerPresenceResolution,
} from "../shared/protocol.js";
import {
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS,
} from "../shared/protocol.js";
import {
  createConversationMetaEntry,
  parseReservedConversationEntry,
  type ConversationMeta,
} from "./conversation-meta.js";
import { deleteConversationNotebook } from "./conversation-notebook.js";
import {
  createReadonlySessionEntriesAdapter,
  inspectPiSessionFile,
  inspectPiSessionFilePresentation,
  validatePiSessionFile,
  type PiSessionFileInspection,
  type PiSessionFilePresentationInspection,
} from "./session-file.js";

const MANIFEST_VERSION = 2;
const CONVERSATION_CATALOG_VERSION = 2;
const MAX_CONVERSATION_CATALOG_BYTES = 4 * 1024 * 1024;
const PROJECT_STATE_DIRECTORY = ".piweb";
const PROJECT_MANIFEST_FILE = "project.json";
const CONVERSATION_CATALOG_FILE = "conversation-catalog.json";
const SESSION_DIRECTORY = "sessions";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const DEFAULT_CONVERSATION_LEASE_TIMEOUT_MS = 5_000;
const MAX_INTEGRITY_PROOF_ATTEMPTS = 8;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const DELETE_QUARANTINE_SUFFIX = ".delete-quarantine";

interface ProjectManifest {
  version: typeof MANIFEST_VERSION;
  projectId: string;
  createdAt: string;
  lastConversationId?: string;
}

type CatalogHeaderEvidence =
  | { kind: "claims"; conversationId: string }
  | { kind: "conclusively_invalid" };

type CatalogBodyEvidence =
  | { kind: "unverified" }
  | { kind: "valid" }
  | { kind: "invalid" };

interface CatalogConversationSummary {
  id: string;
  name?: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface CatalogObservation {
  relativePath: string;
  fingerprint: {
    dev: string;
    ino: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
  };
  header: CatalogHeaderEvidence;
  body: CatalogBodyEvidence;
  summary?: CatalogConversationSummary;
  observedAt: string;
  diagnostic?: string;
}

interface ConversationCatalog {
  version: typeof CONVERSATION_CATALOG_VERSION;
  coverage:
    | { kind: "unknown" }
    | { kind: "complete"; generation: string };
  observations: CatalogObservation[];
}

export interface ConversationLease {
  release(): void;
  upgradeToDeletion(): ConversationDeletionLease;
}

export interface ConversationDeletionLease {
  release(): void;
}

export interface ProjectStoreHandle {
  readonly store: ProjectStore;
  release(): void;
}

/** A complete catalog proof taken after a delete batch commits. */
export interface ConversationDeletionFinalCatalogProof {
  readonly remainingConversationIds: readonly string[];
}

export interface ConversationLeaseWaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ProjectStoreListener = () => void;

interface ProjectStoreRegistryEntry {
  opening: Promise<ProjectStore>;
  references: number;
}

interface SessionFileFingerprint {
  path: string;
  pathKey: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface VerifiedSessionCatalog {
  information: readonly Readonly<SessionInfo>[];
  validatedIdsByPath: ReadonlyMap<string, string>;
  files: readonly Readonly<SessionFileFingerprint>[];
  fingerprintsByPath: ReadonlyMap<
    string,
    Readonly<SessionFileFingerprint>
  >;
}

/**
 * Body-validation receipt for one project JSONL file. It is a version token:
 * the cached conversation identity stays reusable only while every field of
 * the file fingerprint is unchanged, and it never outlives the store that
 * produced it. Same-fingerprint ABA is outside the deletion contract.
 */
interface ValidatedSessionReceipt {
  fingerprint: Readonly<SessionFileFingerprint>;
  conversationId: string;
}

interface VerifiedSessionFileRead {
  path: string;
  raw: string;
  fingerprint: SessionFileFingerprint;
}

interface InspectedSessionFileRead<
  Inspection extends PiSessionFileInspection = PiSessionFileInspection,
> extends VerifiedSessionFileRead {
  inspection: Inspection;
}

interface VerifiedSessionReadBatch {
  catalog: VerifiedSessionCatalog;
  targets: ReadonlyMap<string, InspectedSessionFileRead>;
}

/**
 * Namespace evidence deliberately excludes mutable body fingerprints. A normal
 * append to an unrelated conversation must not invalidate an exact target
 * proof; its path/inode and first-line identity claim remain the authority for
 * this scope.
 */
interface NamespaceHeaderEvidence {
  file: Readonly<SessionFileFingerprint>;
  conversationId?: string;
}

interface NamespaceHeaderCensus {
  evidence: readonly Readonly<NamespaceHeaderEvidence>[];
}


interface VerifiedTargetSessionFileRead<
  Inspection extends PiSessionFileInspection = PiSessionFileInspection,
> {
  target: InspectedSessionFileRead<Inspection>;
  namespace: NamespaceHeaderCensus;
}

interface QuarantinedSessionFile {
  originalPath: string;
  quarantinePath: string;
  quarantineFingerprint: Readonly<SessionFileFingerprint>;
  conversationId: string;
}

interface ConversationLeaseWaiter {
  token: symbol;
  resolve(lease: ConversationLease): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface ConversationLeaseState {
  owner: symbol;
  waiters: ConversationLeaseWaiter[];
}

export class SessionDirectoryChangedError extends Error {
  constructor(
    message = "Project session directory changed while it was being scanned",
  ) {
    super(message);
  }
}

class SessionFileChangedError extends Error {
  constructor(conversationId: string) {
    super(`Conversation changed while it was being read: ${conversationId}`);
  }
}

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
  }
}

/** The transcript replacement is durable even though its catalog refresh failed. */
export class ConversationTruncateCommittedError extends Error {
  readonly sessionFile: string;

  constructor(sessionFile: string, cause: unknown) {
    super(
      `Conversation truncate committed but catalog refresh failed: ${sessionFile}`,
      { cause },
    );
    this.sessionFile = sessionFile;
  }
}

function sessionFileIdentitiesEqual(
  first: Readonly<SessionFileFingerprint>,
  second: Readonly<SessionFileFingerprint>,
): boolean {
  return first.pathKey === second.pathKey
    && first.dev === second.dev
    && first.ino === second.ino;
}

function namespaceTargetEvidenceEqual(
  first: NamespaceHeaderCensus,
  second: NamespaceHeaderCensus,
  conversationId: string,
): boolean {
  const firstCandidates = first.evidence.filter(
    (entry) => entry.conversationId === conversationId,
  );
  const secondCandidates = second.evidence.filter(
    (entry) => entry.conversationId === conversationId,
  );
  return firstCandidates.length === secondCandidates.length
    && firstCandidates.every((entry, index) => {
      const other = secondCandidates[index];
      return other !== undefined
        && sessionFileIdentitiesEqual(entry.file, other.file);
    });
}

function sessionFileIdentitySetsEqual(
  first: readonly Readonly<SessionFileFingerprint>[],
  second: readonly Readonly<SessionFileFingerprint>[],
): boolean {
  return first.length === second.length
    && first.every((file, index) => {
      const other = second[index];
      return other !== undefined && sessionFileIdentitiesEqual(file, other);
    });
}

/**
 * Namespace proof deliberately ignores mutable transcript bodies, but a
 * header claim must be unchanged across the peer-membership observation.
 */
function namespaceHeaderEvidenceSetsEqual(
  first: NamespaceHeaderCensus,
  second: NamespaceHeaderCensus,
): boolean {
  return first.evidence.length === second.evidence.length
    && first.evidence.every((entry, index) => {
      const other = second.evidence[index];
      return other !== undefined
        && entry.conversationId === other.conversationId
        && sessionFileIdentitiesEqual(entry.file, other.file);
    });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
}

function assertSessionId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a valid Pi session id`);
  }
}

function parseDeletionQuarantineBasename(name: string): string {
  const stem = name.slice(0, -DELETE_QUARANTINE_SUFFIX.length);
  const uuidSeparator = stem.lastIndexOf(".");
  const originalBasename = stem.slice(1, uuidSeparator);
  const quarantineId = stem.slice(uuidSeparator + 1);
  if (
    !name.endsWith(DELETE_QUARANTINE_SUFFIX)
    || !stem.startsWith(".")
    || uuidSeparator <= 1
    || originalBasename.length <= ".jsonl".length
    || !originalBasename.endsWith(".jsonl")
    || originalBasename.includes("/")
    || originalBasename.includes("\\")
    || !UUID_PATTERN.test(quarantineId)
  ) {
    throw new Error(
      `Invalid conversation deletion quarantine filename: ${name}`,
    );
  }
  return originalBasename;
}

function parseManifest(raw: string, manifestPath: string): ProjectManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid project manifest at ${manifestPath}: invalid JSON`, {
      cause: error,
    });
  }

  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("manifest must be an object");
    }

    const record = value as Record<string, unknown>;
    const allowedKeys = new Set([
      "version",
      "projectId",
      "createdAt",
      "lastConversationId",
    ]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`unknown field ${JSON.stringify(key)}`);
      }
    }

    if (record.version !== MANIFEST_VERSION) {
      throw new Error(`version must be ${MANIFEST_VERSION}`);
    }
    assertUuid(record.projectId, "projectId");
    if (!isCanonicalIsoDate(record.createdAt)) {
      throw new Error("createdAt must be a canonical ISO timestamp");
    }
    if (record.lastConversationId !== undefined) {
      assertSessionId(record.lastConversationId, "lastConversationId");
    }

    return {
      version: MANIFEST_VERSION,
      projectId: record.projectId,
      createdAt: record.createdAt,
      ...(record.lastConversationId === undefined
        ? {}
        : { lastConversationId: record.lastConversationId }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid project manifest at ${manifestPath}: ${detail}`, {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCatalogKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`unknown catalog field ${JSON.stringify(key)}`);
    }
  }
}

function parseCatalogConversationSummary(
  value: unknown,
): CatalogConversationSummary {
  if (!isRecord(value)) throw new Error("catalog summary must be an object");
  assertCatalogKeys(value, [
    "id",
    "name",
    "preview",
    "createdAt",
    "updatedAt",
    "messageCount",
  ]);
  assertSessionId(value.id, "catalog summary id");
  if (
    typeof value.preview !== "string"
    || Array.from(value.preview).length > MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS
    || !isCanonicalIsoDate(value.createdAt)
    || !isCanonicalIsoDate(value.updatedAt)
    || typeof value.messageCount !== "number"
    || !Number.isInteger(value.messageCount)
    || value.messageCount < 0
  ) {
    throw new Error("catalog summary is invalid");
  }
  if (
    value.name !== undefined
    && (
      typeof value.name !== "string"
      || Array.from(value.name).length > MAX_PROJECT_CONVERSATION_NAME_CHARACTERS
    )
  ) {
    throw new Error("catalog summary name is invalid");
  }
  return {
    id: value.id,
    ...(value.name === undefined ? {} : { name: value.name }),
    preview: value.preview,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messageCount: value.messageCount,
  };
}

function parseCatalogObservation(value: unknown): CatalogObservation {
  if (!isRecord(value)) throw new Error("catalog observation must be an object");
  assertCatalogKeys(value, [
    "relativePath",
    "fingerprint",
    "header",
    "body",
    "summary",
    "observedAt",
    "diagnostic",
  ]);
  if (
    typeof value.relativePath !== "string"
    || value.relativePath !== basename(value.relativePath)
    || !value.relativePath.endsWith(".jsonl")
  ) {
    throw new Error("catalog relativePath must be a session filename");
  }
  if (!isRecord(value.fingerprint)) {
    throw new Error("catalog fingerprint must be an object");
  }
  assertCatalogKeys(value.fingerprint, [
    "dev",
    "ino",
    "size",
    "mtimeNs",
    "ctimeNs",
  ]);
  const fingerprint: CatalogObservation["fingerprint"] = {
    dev: String(value.fingerprint.dev),
    ino: String(value.fingerprint.ino),
    size: String(value.fingerprint.size),
    mtimeNs: String(value.fingerprint.mtimeNs),
    ctimeNs: String(value.fingerprint.ctimeNs),
  };
  if (Object.values(fingerprint).some((part) => !/^\d+$/.test(part))) {
    throw new Error("catalog fingerprint must contain decimal strings");
  }
  if (!isRecord(value.header)) throw new Error("catalog header must be an object");
  assertCatalogKeys(value.header, ["kind", "conversationId"]);
  let header: CatalogHeaderEvidence;
  if (value.header.kind === "claims") {
    assertSessionId(value.header.conversationId, "catalog conversationId");
    header = { kind: "claims", conversationId: value.header.conversationId };
  } else if (value.header.kind === "conclusively_invalid") {
    header = { kind: "conclusively_invalid" };
  } else {
    throw new Error("catalog header kind is invalid");
  }
  if (!isRecord(value.body)) throw new Error("catalog body must be an object");
  assertCatalogKeys(value.body, ["kind"]);
  if (
    value.body.kind !== "unverified"
    && value.body.kind !== "valid"
    && value.body.kind !== "invalid"
  ) {
    throw new Error("catalog body kind is invalid");
  }
  const summary = value.summary === undefined
    ? undefined
    : parseCatalogConversationSummary(value.summary);
  if (
    summary !== undefined
    && (
      header.kind !== "claims"
      || header.conversationId !== summary.id
    )
  ) {
    throw new Error("catalog summary has no matching identity");
  }
  if (
    header.kind === "conclusively_invalid"
    && (summary !== undefined || value.body.kind !== "unverified")
  ) {
    throw new Error("invalid catalog header cannot carry body evidence or summary");
  }
  if (!isCanonicalIsoDate(value.observedAt)) {
    throw new Error("catalog observedAt must be a canonical ISO timestamp");
  }
  if (
    value.diagnostic !== undefined
    && (typeof value.diagnostic !== "string" || value.diagnostic.length > 512)
  ) {
    throw new Error("catalog diagnostic is invalid");
  }
  return {
    relativePath: value.relativePath,
    fingerprint,
    header,
    body: { kind: value.body.kind },
    ...(summary === undefined ? {} : { summary }),
    observedAt: value.observedAt,
    ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic }),
  };
}

function parseConversationCatalog(raw: string): ConversationCatalog {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("catalog must be an object");
  assertCatalogKeys(value, ["version", "coverage", "observations"]);
  if (value.version !== CONVERSATION_CATALOG_VERSION) {
    throw new Error("catalog version is unsupported");
  }
  if (!isRecord(value.coverage)) throw new Error("catalog coverage must be an object");
  assertCatalogKeys(value.coverage, ["kind", "generation"]);
  let coverage: ConversationCatalog["coverage"];
  if (value.coverage.kind === "unknown") {
    coverage = { kind: "unknown" };
  } else if (
    value.coverage.kind === "complete"
    && typeof value.coverage.generation === "string"
    && /^[a-f0-9]{64}$/.test(value.coverage.generation)
  ) {
    coverage = { kind: "complete", generation: value.coverage.generation };
  } else {
    throw new Error("catalog coverage is invalid");
  }
  if (!Array.isArray(value.observations) || value.observations.length > 10_000) {
    throw new Error("catalog observations are invalid");
  }
  const observations = value.observations
    .map((observation) => parseCatalogObservation(observation))
    .sort((first, second) => first.relativePath.localeCompare(second.relativePath));
  if (observations.some((entry, index) =>
    index > 0 && entry.relativePath === observations[index - 1]?.relativePath
  )) {
    throw new Error("catalog contains duplicate paths");
  }
  return {
    version: CONVERSATION_CATALOG_VERSION,
    coverage,
    observations,
  };
}

async function readConversationCatalog(
  catalogPath: string,
): Promise<ConversationCatalog | undefined> {
  try {
    const information = await stat(catalogPath, { bigint: true });
    if (!information.isFile() || information.size > MAX_CONVERSATION_CATALOG_BYTES) {
      return undefined;
    }
    return parseConversationCatalog(await readFile(catalogPath, "utf8"));
  } catch {
    // This is a disposable observation cache. Corruption only forfeits cached
    // presentation and is rebuilt from the transcript without changing it.
    return undefined;
  }
}

async function writeConversationCatalogAtomically(
  catalogPath: string,
  catalog: ConversationCatalog,
): Promise<void> {
  const temporaryPath = join(
    dirname(catalogPath),
    `.${basename(catalogPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(catalog, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporaryPath, catalogPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function writeManifestAtomically(
  manifestPath: string,
  manifest: ProjectManifest,
): Promise<void> {
  const temporaryPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function createFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.create.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
    });
    // A hard link publishes the fully written inode without overwriting an
    // existing conversation with the same durable identity.
    await link(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonicalPath = await realpath(resolve(path));
  const information = await stat(canonicalPath);
  if (!information.isDirectory()) {
    throw new Error(`Project path is not a directory: ${canonicalPath}`);
  }
  return canonicalPath;
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function pathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsAreIdentical(first: string, second: string): boolean {
  return pathIdentity(first) === pathIdentity(second);
}

function cloneSessionInformation(information: SessionInfo): SessionInfo {
  return {
    path: information.path,
    id: information.id,
    cwd: information.cwd,
    ...(information.name === undefined ? {} : { name: information.name }),
    ...(information.parentSessionPath === undefined
      ? {}
      : { parentSessionPath: information.parentSessionPath }),
    created: new Date(information.created.getTime()),
    modified: new Date(information.modified.getTime()),
    messageCount: information.messageCount,
    firstMessage: information.firstMessage,
    allMessagesText: information.allMessagesText,
  };
}

function fingerprintsEqual(
  first: SessionFileFingerprint,
  second: SessionFileFingerprint,
): boolean {
  return first.pathKey === second.pathKey
    && first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeNs === second.mtimeNs
    && first.ctimeNs === second.ctimeNs;
}

function fingerprintSetsEqual(
  first: readonly Readonly<SessionFileFingerprint>[],
  second: readonly Readonly<SessionFileFingerprint>[],
): boolean {
  if (first.length !== second.length) return false;
  const secondByPath = new Map(second.map((item) => [item.pathKey, item]));
  return first.every((item) => {
    const other = secondByPath.get(item.pathKey);
    return other !== undefined && fingerprintsEqual(item, other);
  });
}

function indexFingerprintsByPath(
  files: readonly Readonly<SessionFileFingerprint>[],
): ReadonlyMap<string, Readonly<SessionFileFingerprint>> {
  const indexed = new Map<
    string,
    Readonly<SessionFileFingerprint>
  >();
  for (const file of files) {
    if (indexed.has(file.pathKey)) {
      throw new Error(`Duplicate canonical session path: ${file.path}`);
    }
    indexed.set(file.pathKey, file);
  }
  return indexed;
}

function parseValidatedSessionValues(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function assertCanonicalOwnedDirectory(
  expectedPath: string,
  label: string,
): Promise<void> {
  const lexicalPath = resolve(expectedPath);
  const information = await lstat(lexicalPath);
  if (information.isSymbolicLink()) {
    throw new Error(
      `${label} must not be a symbolic link or junction: ${lexicalPath}`,
    );
  }
  if (!information.isDirectory()) {
    throw new Error(`${label} is not a directory: ${lexicalPath}`);
  }

  const canonicalPath = await realpath(lexicalPath);
  if (!pathsAreIdentical(canonicalPath, lexicalPath)) {
    throw new Error(
      `${label} resolves outside its project-owned path: ${lexicalPath} -> ${canonicalPath}`,
    );
  }
}

function cloneSummary(summary: ConversationSummary): ConversationSummary {
  return { ...summary };
}

function summariesEqual(
  first: readonly ConversationSummary[],
  second: readonly ConversationSummary[],
): boolean {
  return (
    first.length === second.length &&
    first.every((summary, index) => {
      const other = second[index];
      return (
        other !== undefined &&
        summary.id === other.id &&
        summary.name === other.name &&
        summary.preview === other.preview &&
        summary.createdAt === other.createdAt &&
        summary.updatedAt === other.updatedAt &&
        summary.messageCount === other.messageCount
      );
    })
  );
}

function toConversationSummary(
  information: SessionInfo,
): ConversationSummary {
  const createdAt = information.created.getTime();
  const updatedAt = information.modified.getTime();
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
    throw new Error(
      `Pi returned invalid session dates for conversation ${information.id}`,
    );
  }

  return {
    id: information.id,
    ...(information.name === undefined ? {} : { name: information.name }),
    preview: information.messageCount === 0 ? "" : information.firstMessage,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    messageCount: information.messageCount,
    compacting: false,
  };
}

function compareConversationSummaries(
  first: ConversationSummary,
  second: ConversationSummary,
): number {
  const byModified = Date.parse(second.updatedAt) - Date.parse(first.updatedAt);
  if (byModified !== 0) return byModified;
  return second.id.localeCompare(first.id);
}

function toConversationSummaries(
  information: readonly SessionInfo[],
): ConversationSummary[] {
  return information.map(toConversationSummary).sort(compareConversationSummaries);
}

function projectedMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (
      isRecord(block)
      && block.type === "text"
      && typeof block.text === "string"
        ? [block.text]
        : []
    ))
    .join(" ");
}

function projectedMessageActivityAt(
  entryTimestamp: string,
  message: Record<string, unknown>,
): number | undefined {
  if (
    (message.role !== "user" && message.role !== "assistant")
    || !("content" in message)
  ) {
    return undefined;
  }
  if (typeof message.timestamp === "number") return message.timestamp;
  const timestamp = Date.parse(entryTimestamp);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * Mirrors Pi's per-file display summary without asking its whole-directory
 * index to rescan. Callers already own a verified SessionManager; this only
 * creates a disposable presentation projection from that manager's entries.
 */
function toProjectedConversationSummary(
  conversation: SessionManager,
): ConversationSummary | undefined {
  const header = conversation.getHeader();
  const conversationId = conversation.getSessionId();
  if (header === null || header.id !== conversationId) return undefined;
  const createdAt = Date.parse(header.timestamp);
  if (!Number.isFinite(createdAt)) return undefined;

  let messageCount = 0;
  let firstMessage = "";
  let updatedAt = createdAt;
  for (const entry of conversation.getEntries()) {
    if (entry.type !== "message") continue;
    messageCount += 1;
    const message = entry.message as unknown;
    if (!isRecord(message)) continue;
    const activityAt = projectedMessageActivityAt(entry.timestamp, message);
    if (activityAt !== undefined) updatedAt = Math.max(updatedAt, activityAt);
    if (firstMessage || message.role !== "user") continue;
    firstMessage = projectedMessageText(message);
  }

  return {
    id: conversationId,
    ...(conversation.getSessionName() === undefined
      ? {}
      : { name: conversation.getSessionName() }),
    preview: messageCount === 0 ? "" : firstMessage || "(no messages)",
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    messageCount,
    compacting: false,
  };
}

export class ProjectStore {
  readonly id: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly sessionDir: string;

  private readonly manifestPath: string;
  private readonly conversationCatalogPath: string;
  private readonly listeners = new Set<ProjectStoreListener>();
  private manifest: ProjectManifest;
  private conversations: ConversationSummary[] = [];
  private verifiedCatalog?: VerifiedSessionCatalog;
  private conversationCatalog?: ConversationCatalog;
  /**
   * Receipts from the last successful complete proof. Unchanged files reuse
   * their receipt instead of re-reading the body, so a proof costs the bytes
   * that actually changed rather than every project byte.
   */
  private validatedSessionReceipts = new Map<
    string,
    ValidatedSessionReceipt
  >();
  /**
   * Direct actor projections can race a pre-existing whole-directory scan.
   * Keep the newer target summary through that stale scan, then let the next
   * scan re-observe it from disk normally.
   */
  private conversationProjectionRevision = 0;
  private readonly conversationProjectionOverrides = new Map<
    string,
    { revision: number; summary: ConversationSummary }
  >();
  private writeTail: Promise<void> = Promise.resolve();
  private refreshTail: Promise<void> = Promise.resolve();
  private catalogWriteTail: Promise<void> = Promise.resolve();

  private constructor(
    cwd: string,
    stateDir: string,
    sessionDir: string,
    manifestPath: string,
    manifest: ProjectManifest,
  ) {
    this.id = manifest.projectId;
    this.cwd = cwd;
    this.stateDir = stateDir;
    this.sessionDir = sessionDir;
    this.manifestPath = manifestPath;
    this.conversationCatalogPath = join(
      stateDir,
      CONVERSATION_CATALOG_FILE,
    );
    this.manifest = manifest;
  }

  static async open(cwd: string): Promise<ProjectStore> {
    const canonicalCwd = await canonicalDirectory(cwd);
    const stateDir = join(canonicalCwd, PROJECT_STATE_DIRECTORY);
    const sessionDir = join(stateDir, SESSION_DIRECTORY);
    const manifestPath = join(stateDir, PROJECT_MANIFEST_FILE);
    await mkdir(stateDir, { recursive: true });
    await assertCanonicalOwnedDirectory(stateDir, "Project state directory");

    let manifest: ProjectManifest;
    try {
      manifest = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      await mkdir(sessionDir, { recursive: true });
      await assertCanonicalOwnedDirectory(stateDir, "Project state directory");
      await assertCanonicalOwnedDirectory(
        sessionDir,
        "Project session directory",
      );
      manifest = {
        version: MANIFEST_VERSION,
        projectId: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await writeManifestAtomically(manifestPath, manifest);
    }

    await mkdir(sessionDir, { recursive: true });
    await assertCanonicalOwnedDirectory(stateDir, "Project state directory");
    await assertCanonicalOwnedDirectory(
      sessionDir,
      "Project session directory",
    );
    const store = new ProjectStore(
      canonicalCwd,
      stateDir,
      sessionDir,
      manifestPath,
      manifest,
    );
    await store.recoverAbandonedSessionQuarantines();
    store.conversationCatalog = await readConversationCatalog(
      store.conversationCatalogPath,
    );
    store.conversations = store.cachedCatalogConversations();
    return store;
  }

  get lastConversationId(): string | undefined {
    return this.manifest.lastConversationId;
  }

  subscribe(listener: ProjectStoreListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  setLastConversation(conversationId?: string): Promise<void> {
    if (conversationId !== undefined) {
      assertSessionId(conversationId, "conversationId");
    }
    return this.enqueueWrite(async () => {
      if (conversationId === this.manifest.lastConversationId) return;
      await this.assertStateDirectorySafe();
      const next: ProjectManifest = {
        version: MANIFEST_VERSION,
        projectId: this.manifest.projectId,
        createdAt: this.manifest.createdAt,
        ...(conversationId === undefined
          ? {}
          : { lastConversationId: conversationId }),
      };
      await writeManifestAtomically(this.manifestPath, next);
      this.manifest = next;
      this.emit();
    });
  }

  private cachedCatalogConversations(): ConversationSummary[] {
    return (this.conversationCatalog?.observations ?? [])
      .flatMap((observation) =>
        observation.summary === undefined
          ? []
          : [{ ...observation.summary, compacting: false }]
      )
      .sort((first, second) => {
        const byModified = Date.parse(second.updatedAt) - Date.parse(first.updatedAt);
        if (byModified !== 0) return byModified;
        return second.id.localeCompare(first.id);
      });
  }

  listConversations(): ConversationSummary[] {
    return this.conversations.map(cloneSummary);
  }

  /**
   * Resolves only header-level membership from one complete stable census.
   * This is intentionally weaker than an exact open: a present header does
   * not prove the full body is usable.
   */
  async peerPresence(
    conversationIds: readonly string[],
  ): Promise<Map<string, PeerPresenceResolution>> {
    const ids = new Set(conversationIds);
    for (const conversationId of ids) {
      assertSessionId(conversationId, "conversationId");
    }
    return this.enqueueConversationOperation(async () => {
      const census = await this.readStableNamespaceHeaderCensus();
      const confirmedCensus = await this.readStableNamespaceHeaderCensus();
      if (!namespaceHeaderEvidenceSetsEqual(census, confirmedCensus)) {
        throw new SessionDirectoryChangedError(
          "Project session header claims changed while peer presence was being read",
        );
      }
      const presentIds = new Set(
        census.evidence.flatMap(({ conversationId }) =>
          conversationId === undefined ? [] : [conversationId]
        ),
      );
      return new Map<string, PeerPresenceResolution>(
        [...ids].map((conversationId): [string, PeerPresenceResolution] => [
          conversationId,
          presentIds.has(conversationId) ? "present" : "absent",
        ]),
      );
    });
  }

  /** Waits for disposable observation writes scheduled by an owned operation. */
  async drainPendingObservations(): Promise<void> {
    await this.refreshTail;
    await this.catalogWriteTail;
  }

  refreshConversations(): Promise<ConversationSummary[]> {
    return this.enqueueConversationOperation(() => this.scanConversations());
  }

  private async scanConversations(): Promise<ConversationSummary[]> {
    const projectionRevision = this.conversationProjectionRevision;
    const information = await this.listSafeSessionInformation();
    const overrides = [...this.conversationProjectionOverrides.values()]
      .filter((override) => override.revision > projectionRevision);
    const summariesById = new Map(
      toConversationSummaries(information).map((summary) => [summary.id, summary]),
    );
    for (const override of overrides) {
      summariesById.set(override.summary.id, { ...override.summary });
    }
    this.replaceConversations(
      [...summariesById.values()].sort(compareConversationSummaries),
    );
    for (const override of overrides) {
      const current = this.conversationProjectionOverrides.get(
        override.summary.id,
      );
      if (current?.revision === override.revision) {
        this.conversationProjectionOverrides.delete(override.summary.id);
      }
    }
    return this.listConversations();
  }

  /**
   * Updates the in-memory project projection for a verified, actor-owned
   * session without treating the mutable SDK directory index as authority.
   * The catalog cache is deliberately discarded: it could otherwise preserve
   * an older title across a later low-priority scrub.
   */
  projectConversationSession(conversation: SessionManager): void {
    const sessionFile = conversation.getSessionFile();
    if (sessionFile === undefined) return;
    try {
      this.assertLexicallyInsideSessionDirectory(sessionFile);
    } catch {
      return;
    }
    const summary = toProjectedConversationSummary(conversation);
    if (summary === undefined) return;
    const revision = ++this.conversationProjectionRevision;
    this.conversationProjectionOverrides.set(summary.id, {
      revision,
      summary: { ...summary },
    });
    this.replaceConversations(
      [
        ...this.conversations.filter(({ id }) => id !== summary.id),
        summary,
      ].sort(compareConversationSummaries),
    );
    this.verifiedCatalog = undefined;
    this.conversationCatalog = undefined;
  }

  private replaceConversations(conversations: ConversationSummary[]): void {
    if (!summariesEqual(this.conversations, conversations)) {
      this.conversations = conversations;
      this.emit();
    }
  }

  /**
   * Performs at most one full body validation for the disposable catalog.
   * It deliberately has no bearing on transcript authority, exact opening, or
   * destructive operations; callers may run it at low priority and retry the
   * next row after yielding.
   */
  async scrubOneCatalogObservation(): Promise<boolean> {
    const namespace = await this.readStableNamespaceHeaderCensus();
    const prior = this.conversationCatalog;
    const priorByPath = new Map(
      prior?.observations.map((observation) => [
        observation.relativePath,
        observation,
      ]),
    );
    const evidenceByPath = new Map(
      namespace.evidence.map((evidence) => [
        this.catalogRelativePath(evidence.file),
        evidence,
      ]),
    );
    const observedAt = new Date().toISOString();
    const observations = namespace.evidence.map((evidence) => {
      const relativePath = this.catalogRelativePath(evidence.file);
      const header: CatalogHeaderEvidence = evidence.conversationId === undefined
        ? { kind: "conclusively_invalid" }
        : { kind: "claims", conversationId: evidence.conversationId };
      const previous = priorByPath.get(relativePath);
      if (
        previous !== undefined
        && this.catalogFingerprintMatches(previous, evidence.file)
        && this.catalogDisplayIdentityMatches(previous, evidence.file, header)
      ) {
        return {
          ...previous,
          fingerprint: { ...previous.fingerprint },
          header: previous.header.kind === "claims"
            ? { ...previous.header }
            : { kind: "conclusively_invalid" },
          body: { ...previous.body },
          ...(previous.summary === undefined
            ? {}
            : { summary: { ...previous.summary } }),
        } satisfies CatalogObservation;
      }
      const summary = previous?.summary !== undefined
        && this.catalogDisplayIdentityMatches(previous, evidence.file, header)
        ? { ...previous.summary }
        : undefined;
      return {
        relativePath,
        fingerprint: this.catalogFingerprint(evidence.file),
        header,
        body: { kind: "unverified" as const },
        ...(summary === undefined ? {} : { summary }),
        observedAt,
        ...(header.kind === "conclusively_invalid"
          ? { diagnostic: "Session header is conclusively invalid" }
          : {}),
      } satisfies CatalogObservation;
    });
    const target = observations.find((observation) =>
      observation.header.kind === "claims"
      && observation.body.kind === "unverified"
    );
    const targetConversationId = target?.header.kind === "claims"
      ? target.header.conversationId
      : undefined;
    if (target !== undefined && targetConversationId !== undefined) {
      const evidence = evidenceByPath.get(target.relativePath)!;
      try {
        await this.readStableExpectedSessionFile(
          evidence.file,
          targetConversationId,
        );
        target.body = { kind: "valid" };
        delete target.diagnostic;
      } catch (error) {
        // The census fingerprint no longer names the bytes that failed to
        // validate. Leave the cache unchanged so the next scrub starts again
        // from a fresh namespace observation instead of calling it invalid.
        if (error instanceof SessionFileChangedError) return true;
        target.body = { kind: "invalid" };
        target.diagnostic = this.catalogDiagnostic(error);
      }
      target.observedAt = new Date().toISOString();
    }

    const catalog: ConversationCatalog = {
      version: CONVERSATION_CATALOG_VERSION,
      coverage: {
        kind: "complete",
        generation: this.namespaceGeneration(namespace),
      },
      observations: observations.sort((first, second) =>
        first.relativePath.localeCompare(second.relativePath)
      ),
    };
    try {
      const persisted = await this.persistConversationCatalog(catalog, {
        expectedCurrent: prior,
      });
      return target !== undefined || !persisted;
    } catch {
      // A cache write cannot turn a proven transcript operation into failure.
      this.conversationCatalog = undefined;
      return target !== undefined;
    }
  }

  async createConversation(
    conversationId?: string,
    conversationMeta?: ConversationMeta,
    options: { updateRecent?: boolean; refreshIndex?: boolean } = {},
  ): Promise<SessionManager> {
    if (conversationId !== undefined) {
      assertSessionId(conversationId, "conversationId");
    }
    await this.assertSessionDirectorySafe();
    const pending = SessionManager.create(
      this.cwd,
      this.sessionDir,
      conversationId === undefined ? undefined : { id: conversationId },
    );
    const header = pending.getHeader();
    const sessionFile = pending.getSessionFile();
    if (header === null || sessionFile === undefined) {
      throw new Error("Pi did not provide a persistent session header");
    }
    if (
      conversationId !== undefined &&
      pending.getSessionId() !== conversationId
    ) {
      throw new Error(
        `Pi created an unexpected conversation identity: ${pending.getSessionId()}`,
      );
    }
    this.assertLexicallyInsideSessionDirectory(sessionFile);
    if (conversationMeta !== undefined) {
      const meta = createConversationMetaEntry(conversationMeta);
      pending.appendCustomEntry(meta.customType, meta.data);
    }

    const initialEntries = [
      header,
      ...pending.getEntries(),
    ];
    const initialContent =
      `${initialEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    validatePiSessionFile(
      initialContent,
      sessionFile,
      pending.getSessionId(),
    );
    await createFileAtomically(sessionFile, initialContent);
    this.verifiedCatalog = undefined;
    // Atomic creation proves publication, not that a later cleanup may unlink
    // whatever is now at this pathname. Retain this file identity so an SDK
    // open failure can use the normal verified quarantine deletion path.
    const published = await this.fingerprintSafeSessionPath(sessionFile);
    let conversation: SessionManager;
    try {
      conversation = SessionManager.open(
        sessionFile,
        this.sessionDir,
        this.cwd,
      );
    } catch (error) {
      try {
        const quarantined = await this.quarantineSessionFile(
          {
            path: published.path,
            raw: initialContent,
            fingerprint: published,
          },
          pending.getSessionId(),
        );
        await this.unlinkSessionFile(quarantined.quarantinePath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to discard a conversation after its initial SDK open failed",
        );
      }
      throw error;
    }
    this.projectConversationSession(conversation);
    if (options.updateRecent !== false) {
      await this.setLastConversation(conversation.getSessionId());
    }
    if (options.refreshIndex !== false) {
      await this.refreshConversations();
    }
    return conversation;
  }

  async openConversation(
    conversationId: string,
    options: { updateRecent?: boolean } = {},
  ): Promise<SessionManager> {
    const { target, namespace } =
      await this.readVerifiedTargetSessionFile(conversationId);

    let conversation: SessionManager;
    try {
      conversation = SessionManager.open(
        target.path,
        this.sessionDir,
        this.cwd,
      );
    } catch (error) {
      this.verifiedCatalog = undefined;
      throw error;
    }
    if (conversation.getSessionId() !== conversationId) {
      this.verifiedCatalog = undefined;
      throw new Error(
        `Conversation identity changed while opening: ${conversationId}`,
      );
    }

    let afterOpen: SessionFileFingerprint;
    try {
      afterOpen = await this.fingerprintSafeSessionPath(target.path);
    } catch (error) {
      this.verifiedCatalog = undefined;
      throw error;
    }
    if (!fingerprintsEqual(target.fingerprint, afterOpen)) {
      this.verifiedCatalog = undefined;
      throw new SessionFileChangedError(conversationId);
    }

    try {
      const namespaceAfterOpen = await this.readStableNamespaceHeaderCensus();
      if (!namespaceTargetEvidenceEqual(
        namespace,
        namespaceAfterOpen,
        conversationId,
      )) {
        throw new SessionDirectoryChangedError(
          `Project session namespace changed while conversation ${conversationId} was being opened`,
        );
      }
    } catch (error) {
      this.verifiedCatalog = undefined;
      throw error;
    }

    if (options.updateRecent !== false) {
      await this.setLastConversation(conversationId);
    }
    return conversation;
  }

  /**
   * Proves the latest title intent from one actor-owned session file without
   * depending on the mutable whole-project SDK index. The actor's writer lease
   * owns the supplied path; this boundary still revalidates path, identity,
   * file stability, and the complete Pi session payload.
   */
  async hasPersistedConversationNameIntent(
    conversationId: string,
    sessionPath: string | undefined,
    expectedName?: string,
  ): Promise<boolean> {
    assertSessionId(conversationId, "conversationId");
    if (sessionPath === undefined) {
      throw new Error(
        `Persistent session path is missing for conversation ${conversationId}`,
      );
    }
    await this.assertSessionDirectorySafe();

    for (
      let attempt = 0;
      attempt < MAX_INTEGRITY_PROOF_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const expected = await this.fingerprintSafeSessionPath(sessionPath);
        const verified = await this.readStableExpectedSessionFile(
          expected,
          conversationId,
        );
        const values = parseValidatedSessionValues(verified.raw);
        for (let index = values.length - 1; index >= 1; index -= 1) {
          const entry = values[index];
          if (
            typeof entry !== "object"
            || entry === null
            || !("type" in entry)
            || entry.type !== "session_info"
          ) continue;
          if (expectedName === undefined) return true;
          const persistedName = "name" in entry && typeof entry.name === "string"
            ? entry.name.trim() || undefined
            : undefined;
          return persistedName === expectedName;
        }
        return false;
      } catch (error) {
        if (
          !(error instanceof SessionFileChangedError)
          || attempt === MAX_INTEGRITY_PROOF_ATTEMPTS - 1
        ) throw error;
      }
    }
    throw new SessionFileChangedError(conversationId);
  }

  /**
   * Reads host-owned metadata without opening a writable Pi SessionManager or
   * changing the project's recent-conversation pointer.
   */
  async inspectConversation(
    conversationId: string,
  ): Promise<PiSessionFileInspection> {
    assertSessionId(conversationId, "conversationId");
    const { target } = await this.readVerifiedTargetSessionFile(conversationId);
    return target.inspection;
  }

  /**
   * Opt-in transcript read for one cold presentation target. Metadata callers
   * use inspectConversation(s) and never retain physical session entries.
   */
  async inspectConversationPresentation(
    conversationId: string,
  ): Promise<PiSessionFilePresentationInspection> {
    assertSessionId(conversationId, "conversationId");
    const { target } = await this.readVerifiedTargetSessionFile(
      conversationId,
      true,
    );
    return target.inspection;
  }

  async inspectConversations(
    conversationIds: readonly string[],
  ): Promise<Map<string, PiSessionFileInspection>> {
    const uniqueConversationIds = [...new Set(conversationIds)];
    for (const conversationId of uniqueConversationIds) {
      assertSessionId(conversationId, "conversationId");
    }
    const batch = await this.readVerifiedSessionFileBatch(
      uniqueConversationIds,
    );
    const inspections = new Map<string, PiSessionFileInspection>();
    for (const conversationId of uniqueConversationIds) {
      const target = batch.targets.get(conversationId)!;
      inspections.set(conversationId, target.inspection);
    }
    return inspections;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.deleteConversations([conversationId]);
  }

  /**
   * Deletes one frozen set of conversations through one complete catalog
   * transaction and returns the final complete catalog proof. Callers must
   * already own every matching deletion lease.
   */
  deleteConversations(
    conversationIds: readonly string[],
  ): Promise<ConversationDeletionFinalCatalogProof> {
    const uniqueConversationIds = [...new Set(conversationIds)];
    if (uniqueConversationIds.length === 0) {
      return Promise.reject(new Error("At least one conversation is required"));
    }
    for (const conversationId of uniqueConversationIds) {
      assertSessionId(conversationId, "conversationId");
    }
    return this.enqueueConversationOperation(async () => {
      await this.recoverAbandonedSessionQuarantines();
      const batch = await this.readVerifiedSessionFileBatch(
        uniqueConversationIds,
        { allowMissing: true },
      );
      const quarantined: QuarantinedSessionFile[] = [];

      try {
        for (const conversationId of uniqueConversationIds) {
          const target = batch.targets.get(conversationId);
          if (target !== undefined) {
            quarantined.push(await this.quarantineSessionFile(
              target,
              conversationId,
            ));
          }
        }
        const quarantinePaths = quarantined.map(
          ({ quarantinePath }) => quarantinePath,
        );

        // Quarantine changes the controlled JSONL set, so prove the remaining
        // project before any unrelated durable side effect.
        await this.getVerifiedSessionCatalog(quarantinePaths);
        for (const conversationId of uniqueConversationIds) {
          await deleteConversationNotebook(this.stateDir, conversationId);
        }
        await this.clearLastConversationsIf(new Set(uniqueConversationIds));

        // Side effects may have yielded to writers. Revalidate all remaining
        // JSONL files before the irreversible quarantine unlinks.
        await this.getVerifiedSessionCatalog(quarantinePaths);
        for (const entry of quarantined) {
          await this.readStableExpectedSessionFile(
            entry.quarantineFingerprint,
            entry.conversationId,
          );
        }
        for (let index = 0; index < quarantined.length;) {
          const entry = quarantined[index]!;
          await this.unlinkSessionFile(entry.quarantinePath);
          quarantined.splice(index, 1);
        }

        // A successful delete is projected only from a complete proof taken
        // after every captured quarantine has been unlinked.
        const committedCatalog = await this.getVerifiedSessionCatalog();
        const reappeared = committedCatalog.information.find(({ id }) =>
          uniqueConversationIds.includes(id)
        );
        if (reappeared !== undefined) {
          throw new Error(
            `Conversation reappeared during deletion: ${reappeared.id}`,
          );
        }
        this.replaceConversations(toConversationSummaries(
          committedCatalog.information,
        ));
        return {
          remainingConversationIds: Object.freeze(
            committedCatalog.information.map(({ id }) => id).sort(),
          ),
        };
      } catch (error) {
        const recoveryErrors: unknown[] = [];
        for (const entry of [...quarantined].reverse()) {
          try {
            await this.recoverQuarantinedSessionFile(entry);
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError);
          }
        }
        if (recoveryErrors.length > 0) {
          throw new AggregateError(
            [error, ...recoveryErrors],
            "Conversation deletion failed and recovery could not be completed",
          );
        }
        throw error;
      }
    });
  }

  truncateConversation(
    conversationId: string,
    entryId: string,
  ): Promise<string> {
    assertSessionId(conversationId, "conversationId");
    assertSessionId(entryId, "entryId");
    return this.enqueueConversationOperation(async () => {
      const information = await this.listSafeSessionInformation();
      const match = information.find(({ id }) => id === conversationId);
      if (match === undefined) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }
      const safePath = await this.resolveSafeSessionPath(match.path);
      const before = await stat(safePath, { bigint: true });
      const raw = await readFile(safePath, "utf8");
      validatePiSessionFile(raw, safePath, conversationId);
      const lines = raw.split("\n");
      const entryLine = lines.findIndex((line, index) => {
        if (index === 0 || line.trim().length === 0) return false;
        const entry = JSON.parse(line) as { id?: unknown };
        return entry.id === entryId;
      });
      if (entryLine < 1) {
        throw new Error(`Conversation message not found: ${entryId}`);
      }
      const anchor = JSON.parse(lines[entryLine]!) as {
        type?: unknown;
      };
      if (anchor.type !== "message") {
        throw new Error(`Truncation anchor is not a message: ${entryId}`);
      }

      const parsedEntries = lines
        .slice(1)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const activeBranch = createReadonlySessionEntriesAdapter(
        inspectPiSessionFilePresentation(raw, safePath, conversationId).entries,
      ).getBranch();
      const anchorIndex = activeBranch.findIndex(({ id }) => id === entryId);
      if (anchorIndex < 0) {
        throw new Error(`Truncation anchor is not on the active branch: ${entryId}`);
      }
      const retainedEntryIds = new Set(
        activeBranch.slice(0, anchorIndex).map(({ id }) => id),
      );
      const receiptTargetRunIds = new Set<string>();
      for (const entry of parsedEntries) {
        const reserved = parseReservedConversationEntry(entry);
        if (reserved?.kind === "message_delivery_receipt") {
          receiptTargetRunIds.add(reserved.entry.data.targetRunId);
        }
      }

      const retainedLines = [lines[0]!];
      for (let index = 1; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (line.trim().length === 0) continue;
        const entry = JSON.parse(line) as { id: string };
        if (retainedEntryIds.has(entry.id)) retainedLines.push(line);
      }
      let retainedParentId = activeBranch[anchorIndex - 1]?.id ?? null;
      for (const entry of parsedEntries) {
        const entryId = entry.id as string;
        if (retainedEntryIds.has(entryId)) continue;
        const reserved = parseReservedConversationEntry(entry);
        if (
          reserved?.kind !== "message_delivery_receipt"
          && (
            reserved?.kind !== "run_settlement"
            || !receiptTargetRunIds.has(reserved.entry.data.runId)
          )
        ) {
          continue;
        }
        const preserved = {
          ...entry,
          parentId: retainedParentId,
        };
        retainedLines.push(JSON.stringify(preserved));
        retainedParentId = entryId;
      }
      const next = `${retainedLines.join("\n")}\n`;
      validatePiSessionFile(next, safePath, conversationId);

      const temporaryPath = join(
        this.sessionDir,
        `.${basename(safePath)}.${randomUUID()}.truncate.tmp`,
      );
      this.assertLexicallyInsideSessionDirectory(temporaryPath);
      try {
        await writeFile(temporaryPath, next, {
          encoding: "utf8",
          flag: "wx",
        });
        const current = await stat(safePath, { bigint: true });
        if (
          before.dev !== current.dev
          || before.ino !== current.ino
          || before.size !== current.size
          || before.mtimeNs !== current.mtimeNs
        ) {
          throw new Error(
            `Conversation changed while it was being truncated: ${conversationId}`,
          );
        }
        const currentSafePath = await this.resolveSafeSessionPath(safePath);
        if (!pathsAreIdentical(currentSafePath, safePath)) {
          throw new Error(
            `Conversation path changed while it was being truncated: ${conversationId}`,
          );
        }
        await rename(temporaryPath, safePath);
        this.verifiedCatalog = undefined;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      try {
        await this.scanConversations();
      } catch (error) {
        throw new ConversationTruncateCommittedError(safePath, error);
      }
      return safePath;
    });
  }

  private clearLastConversationsIf(
    conversationIds: ReadonlySet<string>,
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const lastConversationId = this.manifest.lastConversationId;
      if (
        lastConversationId === undefined
        || !conversationIds.has(lastConversationId)
      ) return;
      await this.assertStateDirectorySafe();
      const next: ProjectManifest = {
        version: MANIFEST_VERSION,
        projectId: this.manifest.projectId,
        createdAt: this.manifest.createdAt,
      };
      await writeManifestAtomically(this.manifestPath, next);
      this.manifest = next;
      this.emit();
    });
  }

  private catalogRelativePath(file: Readonly<SessionFileFingerprint>): string {
    const relativePath = relative(this.sessionDir, file.path);
    if (
      relativePath !== basename(relativePath)
      || !relativePath.endsWith(".jsonl")
    ) {
      throw new Error(`Invalid catalog session path: ${file.path}`);
    }
    return relativePath;
  }

  private catalogFingerprint(
    file: Readonly<SessionFileFingerprint>,
  ): CatalogObservation["fingerprint"] {
    return {
      dev: file.dev.toString(),
      ino: file.ino.toString(),
      size: file.size.toString(),
      mtimeNs: file.mtimeNs.toString(),
      ctimeNs: file.ctimeNs.toString(),
    };
  }

  private catalogFingerprintMatches(
    observation: CatalogObservation,
    file: Readonly<SessionFileFingerprint>,
  ): boolean {
    const fingerprint = this.catalogFingerprint(file);
    return observation.fingerprint.dev === fingerprint.dev
      && observation.fingerprint.ino === fingerprint.ino
      && observation.fingerprint.size === fingerprint.size
      && observation.fingerprint.mtimeNs === fingerprint.mtimeNs
      && observation.fingerprint.ctimeNs === fingerprint.ctimeNs;
  }

  /** A display summary is stable across body changes, not file replacement. */
  private catalogDisplayIdentityMatches(
    observation: CatalogObservation,
    file: Readonly<SessionFileFingerprint>,
    header: CatalogHeaderEvidence,
  ): boolean {
    const fingerprint = this.catalogFingerprint(file);
    if (
      observation.fingerprint.dev !== fingerprint.dev
      || observation.fingerprint.ino !== fingerprint.ino
      || observation.header.kind !== header.kind
    ) return false;
    return header.kind === "conclusively_invalid"
      || (
        observation.header.kind === "claims"
        && observation.header.conversationId === header.conversationId
      );
  }

  private namespaceGeneration(namespace: NamespaceHeaderCensus): string {
    const hash = createHash("sha256");
    for (const evidence of namespace.evidence) {
      const file = evidence.file;
      hash.update(this.catalogRelativePath(file));
      hash.update("\0");
      hash.update(file.dev.toString());
      hash.update("\0");
      hash.update(file.ino.toString());
      hash.update("\0");
      hash.update(evidence.conversationId ?? "");
      hash.update("\n");
    }
    return hash.digest("hex");
  }

  private catalogDiagnostic(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 512);
  }

  private async persistConversationCatalog(
    catalog: ConversationCatalog,
    options?: { expectedCurrent: ConversationCatalog | undefined },
  ): Promise<boolean> {
    let persisted = false;
    const next = this.catalogWriteTail.then(async () => {
      if (
        options !== undefined
        && this.conversationCatalog !== options.expectedCurrent
      ) return;
      await this.assertStateDirectorySafe();
      await writeConversationCatalogAtomically(
        this.conversationCatalogPath,
        catalog,
      );
      this.conversationCatalog = catalog;
      persisted = true;
    });
    this.catalogWriteTail = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
    return persisted;
  }

  private async publishVerifiedConversationCatalog(
    catalog: VerifiedSessionCatalog,
  ): Promise<void> {
    const observedAt = new Date().toISOString();
    const summariesByPath = new Map(
      catalog.information.map((information) => [
        pathIdentity(information.path),
        toConversationSummary(information),
      ]),
    );
    const observations = catalog.files.map((file) => {
      const conversationId = catalog.validatedIdsByPath.get(file.pathKey);
      const summary = summariesByPath.get(file.pathKey);
      if (conversationId === undefined || summary === undefined) {
        throw new Error(`Verified catalog omitted a session identity: ${file.path}`);
      }
      return {
        relativePath: this.catalogRelativePath(file),
        fingerprint: this.catalogFingerprint(file),
        header: { kind: "claims" as const, conversationId },
        body: { kind: "valid" as const },
        summary: {
          id: summary.id,
          ...(summary.name === undefined ? {} : { name: summary.name }),
          preview: summary.preview,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          messageCount: summary.messageCount,
        },
        observedAt,
      } satisfies CatalogObservation;
    });
    const namespace: NamespaceHeaderCensus = {
      evidence: catalog.files.map((file) => ({
        file,
        conversationId: catalog.validatedIdsByPath.get(file.pathKey),
      })),
    };
    await this.persistConversationCatalog({
      version: CONVERSATION_CATALOG_VERSION,
      coverage: {
        kind: "complete",
        generation: this.namespaceGeneration(namespace),
      },
      observations,
    });
  }

  private enqueueConversationOperation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.refreshTail.then(task);
    this.refreshTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const result = this.writeTail.then(task);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A subscriber cannot roll back a durable state change.
      }
    }
  }

  private assertStateDirectorySafe(): Promise<void> {
    return assertCanonicalOwnedDirectory(
      this.stateDir,
      "Project state directory",
    );
  }

  private async assertSessionDirectorySafe(): Promise<void> {
    await this.assertStateDirectorySafe();
    await assertCanonicalOwnedDirectory(
      this.sessionDir,
      "Project session directory",
    );
  }

  private async listSafeSessionInformation(): Promise<SessionInfo[]> {
    const catalog = await this.getVerifiedSessionCatalog();
    return catalog.information.map(cloneSessionInformation);
  }

  private async getVerifiedSessionCatalog(
    allowedQuarantinePaths?: readonly string[] | string,
  ): Promise<VerifiedSessionCatalog> {
    for (
      let attempt = 0;
      attempt < MAX_INTEGRITY_PROOF_ATTEMPTS;
      attempt += 1
    ) {
      let currentFiles: SessionFileFingerprint[];
      try {
        currentFiles = await this.listSafeSessionFiles(
          allowedQuarantinePaths,
        );
      } catch (error) {
        this.verifiedCatalog = undefined;
        throw error;
      }

      const catalog = this.verifiedCatalog;
      if (catalog && fingerprintSetsEqual(catalog.files, currentFiles)) {
        return catalog;
      }

      this.verifiedCatalog = undefined;
      try {
        return await this.scanSafeSessionInformation(
          currentFiles,
          allowedQuarantinePaths,
        );
      } catch (error) {
        if (
          !(error instanceof SessionDirectoryChangedError)
          || attempt === MAX_INTEGRITY_PROOF_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
    throw new SessionDirectoryChangedError();
  }

  private async scanSafeSessionInformation(
    filesBeforeScan: readonly SessionFileFingerprint[],
    allowedQuarantinePaths?: readonly string[] | string,
  ): Promise<VerifiedSessionCatalog> {
    const information = await SessionManager.listAll(this.sessionDir);
    const validatedByPath = new Map<string, string>();
    const pathsByConversation = new Map<string, string>();

    const provedReceipts: ValidatedSessionReceipt[] = [];
    for (const file of filesBeforeScan) {
      const beforeRead = await this.fingerprintSafeSessionPath(file.path);
      if (!fingerprintsEqual(file, beforeRead)) {
        throw new SessionDirectoryChangedError();
      }
      const receipt = this.validatedSessionReceipts.get(file.pathKey);
      const conversationId = receipt !== undefined
          && fingerprintsEqual(receipt.fingerprint, beforeRead)
        ? receipt.conversationId
        : await this.readValidatedSessionFile(file.path, beforeRead);
      provedReceipts.push({ fingerprint: beforeRead, conversationId });
      const previousPath = pathsByConversation.get(conversationId);
      if (
        previousPath !== undefined
        && !pathsAreIdentical(previousPath, file.path)
      ) {
        throw new Error(
          `Duplicate conversation identity ${conversationId}: ${previousPath} and ${file.path}`,
        );
      }
      pathsByConversation.set(conversationId, file.path);
      validatedByPath.set(file.pathKey, conversationId);
    }

    const indexedPaths = new Set<string>();
    const normalizedInformation: SessionInfo[] = [];
    for (const session of information) {
      const safePath = await this.resolveSafeSessionPath(session.path);
      const pathKey = pathIdentity(safePath);
      const validatedId = validatedByPath.get(pathKey);
      if (validatedId === undefined) {
        throw new Error(`Pi indexed an unknown project session file: ${safePath}`);
      }
      if (validatedId !== session.id) {
        throw new Error(
          `Pi indexed session ${session.id} with mismatched file identity ${validatedId}: ${safePath}`,
        );
      }
      if (indexedPaths.has(pathKey)) {
        throw new Error(`Pi indexed a project session file more than once: ${safePath}`);
      }
      indexedPaths.add(pathKey);
      normalizedInformation.push(cloneSessionInformation({
        ...session,
        path: safePath,
      }));
    }
    if (indexedPaths.size !== validatedByPath.size) {
      const omittedPath = [...validatedByPath.keys()].find(
        (path) => !indexedPaths.has(path),
      );
      throw new Error(
        `Pi omitted a valid project session file from its index: ${String(omittedPath)}`,
      );
    }

    const filesAfterScan = await this.listSafeSessionFiles(
      allowedQuarantinePaths,
    );
    if (!fingerprintSetsEqual(filesBeforeScan, filesAfterScan)) {
      throw new SessionDirectoryChangedError();
    }
    // Validate all SDK-derived summary fields before publishing the proof.
    toConversationSummaries(normalizedInformation);
    this.validatedSessionReceipts = new Map(
      provedReceipts.map((receipt) => [
        receipt.fingerprint.pathKey,
        receipt,
      ]),
    );

    const catalogInformation = normalizedInformation.map((item) =>
      Object.freeze(cloneSessionInformation(item))
    );
    const catalogFiles = filesAfterScan.map((file) =>
      Object.freeze({ ...file })
    );
    const frozenCatalogFiles = Object.freeze(catalogFiles);
    const catalog = Object.freeze({
      information: Object.freeze(catalogInformation),
      validatedIdsByPath: new Map(validatedByPath),
      files: frozenCatalogFiles,
      fingerprintsByPath: indexFingerprintsByPath(frozenCatalogFiles),
    });
    this.verifiedCatalog = catalog;
    try {
      await this.publishVerifiedConversationCatalog(catalog);
    } catch {
      // The catalog is an observation cache; a failed replacement only loses
      // acceleration and must not invalidate the complete transcript proof.
      this.conversationCatalog = undefined;
    }
    return catalog;
  }

  /**
   * Reads one project JSONL body and proves it was stable around the read.
   * Callers that hold a matching receipt skip this entirely.
   */
  private async readValidatedSessionFile(
    path: string,
    beforeRead: Readonly<SessionFileFingerprint>,
  ): Promise<string> {
    const raw = await readFile(path, "utf8");
    const afterRead = await this.fingerprintSafeSessionPath(path);
    if (!fingerprintsEqual(beforeRead, afterRead)) {
      throw new SessionDirectoryChangedError();
    }
    return validatePiSessionFile(raw, path);
  }

  private async listSafeSessionFiles(
    allowedQuarantinePaths?: readonly string[] | string,
  ): Promise<SessionFileFingerprint[]> {
    await this.assertSessionDirectorySafe();
    const entries = await readdir(this.sessionDir, { withFileTypes: true });
    const allowedQuarantinePathKeys = new Set(
      (typeof allowedQuarantinePaths === "string"
        ? [allowedQuarantinePaths]
        : allowedQuarantinePaths ?? []).map(pathIdentity),
    );
    const files: SessionFileFingerprint[] = [];
    for (const entry of entries) {
      const entryPath = join(this.sessionDir, entry.name);
      if (entry.name.endsWith(DELETE_QUARANTINE_SUFFIX)) {
        parseDeletionQuarantineBasename(entry.name);
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new Error(
            `Conversation deletion quarantine must be a regular project-owned file: ${entryPath}`,
          );
        }
        const quarantine = await this.fingerprintSafeSessionPath(entryPath);
        if (!allowedQuarantinePathKeys.has(quarantine.pathKey)) {
          throw new Error(
            `Abandoned conversation deletion quarantine requires recovery: ${entryPath}`,
          );
        }
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(
          `Session entry must be a regular project-owned file: ${entryPath}`,
        );
      }
      files.push(await this.fingerprintSafeSessionPath(entryPath));
    }
    await this.assertSessionDirectorySafe();
    return files.sort((first, second) =>
      first.pathKey.localeCompare(second.pathKey)
    );
  }

  private async fingerprintSafeSessionPath(
    path: string,
  ): Promise<SessionFileFingerprint> {
    this.assertLexicallyInsideSessionDirectory(path);
    const lexicalPath = resolve(path);
    const entryInformation = await lstat(lexicalPath, { bigint: true });
    if (entryInformation.isSymbolicLink() || !entryInformation.isFile()) {
      throw new Error(
        `Session entry must be a regular project-owned file: ${lexicalPath}`,
      );
    }
    const canonicalPath = await realpath(lexicalPath);
    if (!pathsAreIdentical(lexicalPath, canonicalPath)) {
      throw new Error(
        `Session entry resolves outside its project-owned path: ${lexicalPath} -> ${canonicalPath}`,
      );
    }
    const information = await stat(canonicalPath, { bigint: true });
    if (!information.isFile()) {
      throw new Error(
        `Session entry must be a regular project-owned file: ${canonicalPath}`,
      );
    }
    return {
      path: canonicalPath,
      pathKey: pathIdentity(canonicalPath),
      dev: information.dev,
      ino: information.ino,
      size: information.size,
      mtimeNs: information.mtimeNs,
      ctimeNs: information.ctimeNs,
    };
  }

  /**
   * Proves the namespace needed to resolve one exact conversation without
   * reading any transcript body. A header that cannot be parsed within the
   * fixed first-line limit is conclusively not an identity candidate; I/O and
   * path uncertainty still fail the census closed.
   */
  private async readStableNamespaceHeaderCensus(): Promise<NamespaceHeaderCensus> {
    const filesBeforeRead = await this.listSafeSessionFiles();
    const evidence: NamespaceHeaderEvidence[] = [];
    for (const file of filesBeforeRead) {
      evidence.push(await this.readSessionHeaderEvidence(file));
    }
    const filesAfterRead = await this.listSafeSessionFiles();
    if (!sessionFileIdentitySetsEqual(filesBeforeRead, filesAfterRead)) {
      throw new SessionDirectoryChangedError(
        "Project session namespace changed while headers were being read",
      );
    }
    return { evidence: Object.freeze(evidence) };
  }

  private async readSessionHeaderEvidence(
    expectedFile: Readonly<SessionFileFingerprint>,
  ): Promise<NamespaceHeaderEvidence> {
    const beforeRead = await this.fingerprintSafeSessionPath(expectedFile.path);
    if (!sessionFileIdentitiesEqual(expectedFile, beforeRead)) {
      throw new SessionDirectoryChangedError(
        "Project session namespace changed while a header was being read",
      );
    }

    const handle = await openFile(beforeRead.path, "r");
    let headerLine: string | undefined;
    try {
      const buffer = Buffer.allocUnsafe(MAX_SESSION_HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const lineEnd = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (lineEnd >= 0) {
        headerLine = buffer.subarray(0, lineEnd).toString("utf8");
      }
    } finally {
      await handle.close();
    }

    const afterRead = await this.fingerprintSafeSessionPath(beforeRead.path);
    if (!sessionFileIdentitiesEqual(beforeRead, afterRead)) {
      throw new SessionDirectoryChangedError(
        "Project session namespace changed while a header was being read",
      );
    }

    if (headerLine === undefined) return { file: afterRead };
    try {
      return {
        file: afterRead,
        conversationId: validatePiSessionFile(
          `${headerLine}\n`,
          afterRead.path,
        ),
      };
    } catch {
      return { file: afterRead };
    }
  }

  private readVerifiedTargetSessionFile(
    conversationId: string,
    includeEntries: true,
  ): Promise<VerifiedTargetSessionFileRead<PiSessionFilePresentationInspection>>;
  private readVerifiedTargetSessionFile(
    conversationId: string,
    includeEntries?: false,
  ): Promise<VerifiedTargetSessionFileRead>;
  private async readVerifiedTargetSessionFile(
    conversationId: string,
    includeEntries = false,
  ): Promise<
    | VerifiedTargetSessionFileRead
    | VerifiedTargetSessionFileRead<PiSessionFilePresentationInspection>
  > {
    assertSessionId(conversationId, "conversationId");
    for (
      let attempt = 0;
      attempt < MAX_INTEGRITY_PROOF_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const namespaceBeforeTarget = await this.readStableNamespaceHeaderCensus();
        const candidates = namespaceBeforeTarget.evidence.filter(
          (entry) => entry.conversationId === conversationId,
        );
        if (candidates.length === 0) {
          throw new ConversationNotFoundError(conversationId);
        }
        if (candidates.length > 1) {
          throw new Error(
            `Duplicate conversation identity ${conversationId}: ${candidates.map(({ file }) => file.path).join(", ")}`,
          );
        }

        const target = includeEntries === true
          ? await this.readStableExpectedSessionFile(
            candidates[0]!.file,
            conversationId,
            true,
          )
          : await this.readStableExpectedSessionFile(
            candidates[0]!.file,
            conversationId,
          );
        const namespaceAfterTarget = await this.readStableNamespaceHeaderCensus();
        if (!namespaceTargetEvidenceEqual(
          namespaceBeforeTarget,
          namespaceAfterTarget,
          conversationId,
        )) {
          throw new SessionDirectoryChangedError(
            `Project session namespace changed while conversation ${conversationId} was being read`,
          );
        }
        return { target, namespace: namespaceAfterTarget };
      } catch (error) {
        this.verifiedCatalog = undefined;
        if (
          (
            !(error instanceof SessionDirectoryChangedError)
            && !(error instanceof SessionFileChangedError)
          )
          || attempt === MAX_INTEGRITY_PROOF_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
    throw new SessionDirectoryChangedError();
  }

  private async readVerifiedSessionFileBatch(
    conversationIds: readonly string[],
    options: { allowMissing?: boolean } = {},
  ): Promise<VerifiedSessionReadBatch> {
    for (
      let attempt = 0;
      attempt < MAX_INTEGRITY_PROOF_ATTEMPTS;
      attempt += 1
    ) {
      const catalog = await this.getVerifiedSessionCatalog();
      const informationById = new Map(
        catalog.information.map((item) => [item.id, item]),
      );
      const targets = new Map<string, InspectedSessionFileRead>();

      try {
        for (const conversationId of conversationIds) {
          const information = informationById.get(conversationId);
          if (information === undefined) {
            if (options.allowMissing === true) continue;
            throw new Error(`Conversation not found: ${conversationId}`);
          }
          const pathKey = pathIdentity(information.path);
          const expectedFile = catalog.fingerprintsByPath.get(pathKey);
          if (
            catalog.validatedIdsByPath.get(pathKey) !== conversationId
            || expectedFile === undefined
          ) {
            throw new SessionFileChangedError(conversationId);
          }
          targets.set(
            conversationId,
            await this.readStableExpectedSessionFile(
              expectedFile,
              conversationId,
            ),
          );
        }

        const filesAfterRead = await this.listSafeSessionFiles();
        if (!fingerprintSetsEqual(catalog.files, filesAfterRead)) {
          throw new SessionDirectoryChangedError(
            "Project session directory changed while conversations were being read",
          );
        }
        return { catalog, targets };
      } catch (error) {
        this.verifiedCatalog = undefined;
        if (
          (
            !(error instanceof SessionDirectoryChangedError)
            && !(error instanceof SessionFileChangedError)
          )
          || attempt === MAX_INTEGRITY_PROOF_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }
    throw new SessionDirectoryChangedError();
  }

  private readStableExpectedSessionFile(
    expectedFile: Readonly<SessionFileFingerprint>,
    conversationId: string,
    includeEntries: true,
  ): Promise<InspectedSessionFileRead<PiSessionFilePresentationInspection>>;
  private readStableExpectedSessionFile(
    expectedFile: Readonly<SessionFileFingerprint>,
    conversationId: string,
    includeEntries?: false,
  ): Promise<InspectedSessionFileRead>;
  private async readStableExpectedSessionFile(
    expectedFile: Readonly<SessionFileFingerprint>,
    conversationId: string,
    includeEntries = false,
  ): Promise<
    | InspectedSessionFileRead
    | InspectedSessionFileRead<PiSessionFilePresentationInspection>
  > {
    try {
      const beforeRead = await this.fingerprintSafeSessionPath(
        expectedFile.path,
      );
      if (!fingerprintsEqual(expectedFile, beforeRead)) {
        throw new SessionFileChangedError(conversationId);
      }
      const raw = await readFile(beforeRead.path, "utf8");
      const afterRead = await this.fingerprintSafeSessionPath(beforeRead.path);
      if (!fingerprintsEqual(beforeRead, afterRead)) {
        throw new SessionFileChangedError(conversationId);
      }
      const inspection = includeEntries === true
        ? inspectPiSessionFilePresentation(
          raw,
          afterRead.path,
          conversationId,
        )
        : inspectPiSessionFile(raw, afterRead.path, conversationId);
      return {
        path: afterRead.path,
        raw,
        fingerprint: afterRead,
        inspection,
      };
    } catch (error) {
      this.verifiedCatalog = undefined;
      throw error;
    }
  }

  private async recoverAbandonedSessionQuarantines(): Promise<void> {
    await this.assertSessionDirectorySafe();
    const entries = await readdir(this.sessionDir, { withFileTypes: true });
    const quarantineEntries = entries
      .filter(({ name }) => name.endsWith(DELETE_QUARANTINE_SUFFIX))
      .sort((first, second) => first.name.localeCompare(second.name));

    for (const entry of quarantineEntries) {
      const originalBasename = parseDeletionQuarantineBasename(entry.name);
      const quarantinePath = join(this.sessionDir, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(
          `Conversation deletion quarantine must be a regular project-owned file: ${quarantinePath}`,
        );
      }

      const beforeRead = await this.fingerprintSafeSessionPath(quarantinePath);
      const raw = await readFile(beforeRead.path, "utf8");
      const afterRead = await this.fingerprintSafeSessionPath(beforeRead.path);
      if (!fingerprintsEqual(beforeRead, afterRead)) {
        throw new SessionDirectoryChangedError(
          `Conversation deletion quarantine changed while it was being recovered: ${quarantinePath}`,
        );
      }
      const conversationId = validatePiSessionFile(raw, afterRead.path);

      await this.recoverQuarantinedSessionFile({
        originalPath: join(this.sessionDir, originalBasename),
        quarantinePath: afterRead.path,
        quarantineFingerprint: afterRead,
        conversationId,
      });
    }
    await this.assertSessionDirectorySafe();
    if (quarantineEntries.length > 0) {
      this.verifiedCatalog = undefined;
    }
  }

  private async quarantineSessionFile(
    target: VerifiedSessionFileRead,
    conversationId: string,
  ): Promise<QuarantinedSessionFile> {
    const quarantinePath = join(
      this.sessionDir,
      `.${basename(target.path)}.${randomUUID()}.delete-quarantine`,
    );
    this.assertLexicallyInsideSessionDirectory(quarantinePath);
    let moved = false;
    try {
      await this.renameSessionFile(target.path, quarantinePath);
      moved = true;
      this.verifiedCatalog = undefined;
      const quarantineFingerprint =
        await this.fingerprintSafeSessionPath(quarantinePath);
      if (
        quarantineFingerprint.dev !== target.fingerprint.dev
        || quarantineFingerprint.ino !== target.fingerprint.ino
      ) {
        throw new SessionFileChangedError(conversationId);
      }
      const verified = await this.readStableExpectedSessionFile(
        quarantineFingerprint,
        conversationId,
      );
      return {
        originalPath: target.path,
        quarantinePath,
        quarantineFingerprint: verified.fingerprint,
        conversationId,
      };
    } catch (error) {
      this.verifiedCatalog = undefined;
      if (moved) {
        try {
          const quarantineFingerprint =
            await this.fingerprintSafeSessionPath(quarantinePath);
          await this.recoverQuarantinedSessionFile({
            originalPath: target.path,
            quarantinePath,
            quarantineFingerprint,
            conversationId,
          });
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            `Conversation quarantine failed and recovery could not be completed: ${conversationId}`,
          );
        }
      }
      throw error;
    }
  }

  private async recoverQuarantinedSessionFile(
    quarantined: QuarantinedSessionFile,
  ): Promise<void> {
    await this.readStableExpectedSessionFile(
      quarantined.quarantineFingerprint,
      quarantined.conversationId,
    );

    let restoreError: unknown;
    try {
      await link(quarantined.quarantinePath, quarantined.originalPath);
    } catch (error) {
      restoreError = error;
    }
    if (restoreError === undefined) {
      await this.unlinkSessionFile(quarantined.quarantinePath);
      return;
    }
    if (!isNodeError(restoreError, "EEXIST")) {
      throw restoreError;
    }

    const [quarantineAfterCollision, originalAfterCollision] =
      await Promise.all([
        this.fingerprintSafeSessionPath(quarantined.quarantinePath),
        this.fingerprintSafeSessionPath(quarantined.originalPath),
      ]);
    if (
      quarantineAfterCollision.dev === originalAfterCollision.dev
      && quarantineAfterCollision.ino === originalAfterCollision.ino
    ) {
      await this.unlinkSessionFile(quarantined.quarantinePath);
      return;
    }

    const recoveryPath = join(
      this.sessionDir,
      `.${basename(quarantined.originalPath, ".jsonl")}.${randomUUID()}.delete-recovery.jsonl`,
    );
    this.assertLexicallyInsideSessionDirectory(recoveryPath);
    try {
      await link(quarantined.quarantinePath, recoveryPath);
      await this.unlinkSessionFile(quarantined.quarantinePath);
    } catch (recoveryError) {
      throw new AggregateError(
        [restoreError, recoveryError],
        `Quarantined conversation remains at ${quarantined.quarantinePath}`,
      );
    }
  }

  private renameSessionFile(source: string, destination: string): Promise<void> {
    return rename(source, destination);
  }

  private unlinkSessionFile(path: string): Promise<void> {
    return unlink(path);
  }

  private assertLexicallyInsideSessionDirectory(path: string): void {
    const sessionRoot = resolve(this.sessionDir);
    const candidate = resolve(path);
    if (!isPathInside(sessionRoot, candidate)) {
      throw new Error(`Session path escapes the project session directory: ${path}`);
    }
  }

  private async resolveSafeSessionPath(path: string): Promise<string> {
    this.assertLexicallyInsideSessionDirectory(path);
    const [sessionRoot, candidate] = await Promise.all([
      realpath(this.sessionDir),
      realpath(path),
    ]);
    if (!isPathInside(sessionRoot, candidate)) {
      throw new Error(`Session path escapes the project session directory: ${path}`);
    }
    return candidate;
  }
}

export class ProjectStoreRegistry {
  private readonly stores = new Map<string, ProjectStoreRegistryEntry>();
  private readonly leases = new Map<string, ConversationLeaseState>();

  async acquireProject(cwd: string): Promise<ProjectStoreHandle> {
    const canonicalCwd = await canonicalDirectory(cwd);
    const key = pathIdentity(canonicalCwd);
    const entry = this.getOrCreateProjectEntry(key, canonicalCwd);
    entry.references += 1;

    let store: ProjectStore;
    try {
      store = await entry.opening;
    } catch (error) {
      entry.references -= 1;
      this.deleteProjectEntry(key, entry);
      throw error;
    }

    let released = false;
    return {
      store,
      release: () => {
        if (released) return;
        released = true;
        entry.references -= 1;
        if (entry.references === 0) {
          this.deleteProjectEntry(key, entry);
        }
      },
    };
  }

  acquireConversation(
    canonicalCwd: string,
    conversationId: string,
  ): ConversationLease {
    const key = this.conversationLeaseKey(canonicalCwd, conversationId);
    if (this.leases.has(key)) {
      throw new Error(
        `Conversation ${conversationId} in project ${resolve(canonicalCwd)} is already leased`,
      );
    }

    const token = Symbol(key);
    const state: ConversationLeaseState = {
      owner: token,
      waiters: [],
    };
    this.leases.set(key, state);
    return this.createConversationLease(key, state, token);
  }

  acquireConversationWhenAvailable(
    canonicalCwd: string,
    conversationId: string,
    options: ConversationLeaseWaitOptions = {},
  ): Promise<ConversationLease> {
    const key = this.conversationLeaseKey(canonicalCwd, conversationId);
    const timeoutMs =
      options.timeoutMs ?? DEFAULT_CONVERSATION_LEASE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("timeoutMs must be a finite non-negative number");
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError());
    }

    const current = this.leases.get(key);
    if (current === undefined) {
      return Promise.resolve(
        this.acquireConversation(canonicalCwd, conversationId),
      );
    }

    return new Promise<ConversationLease>((resolveLease, rejectLease) => {
      const waiter: ConversationLeaseWaiter = {
        token: Symbol(key),
        resolve: resolveLease,
        reject: rejectLease,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        settled: false,
      };

      if (options.signal !== undefined) {
        waiter.abortListener = () => {
          this.cancelConversationWaiter(
            key,
            current,
            waiter,
            this.createAbortError(),
          );
        };
        options.signal.addEventListener("abort", waiter.abortListener, {
          once: true,
        });
      }
      waiter.timer = setTimeout(() => {
        this.cancelConversationWaiter(
          key,
          current,
          waiter,
          new Error(
            `Timed out waiting for conversation ${conversationId} in project ${resolve(canonicalCwd)}`,
          ),
        );
      }, timeoutMs);
      current.waiters.push(waiter);
    });
  }

  private getOrCreateProjectEntry(
    key: string,
    canonicalCwd: string,
  ): ProjectStoreRegistryEntry {
    const existing = this.stores.get(key);
    if (existing !== undefined) return existing;

    const entry: ProjectStoreRegistryEntry = {
      opening: ProjectStore.open(canonicalCwd),
      references: 0,
    };
    this.stores.set(key, entry);
    return entry;
  }

  private deleteProjectEntry(
    key: string,
    entry: ProjectStoreRegistryEntry,
  ): void {
    if (this.stores.get(key) === entry) {
      this.stores.delete(key);
    }
  }

  private conversationLeaseKey(
    canonicalCwd: string,
    conversationId: string,
  ): string {
    if (typeof canonicalCwd !== "string" || !isAbsolute(canonicalCwd)) {
      throw new Error("canonicalCwd must be an absolute path");
    }
    assertSessionId(conversationId, "conversationId");
    const cwdKey = pathIdentity(canonicalCwd);
    return `${cwdKey.length}:${cwdKey}:${conversationId}`;
  }

  private createConversationLease(
    key: string,
    state: ConversationLeaseState,
    token: symbol,
  ): ConversationLease {
    let released = false;
    let upgraded = false;
    return {
      release: () => {
        if (released || upgraded) return;
        released = true;
        this.releaseConversationLease(key, state, token);
      },
      upgradeToDeletion: () => {
        if (released || upgraded) {
          throw new Error("Conversation lease is no longer owned");
        }
        if (this.leases.get(key) !== state || state.owner !== token) {
          throw new Error("Conversation lease ownership changed");
        }
        upgraded = true;
        return this.createConversationDeletionLease(key, state, token);
      },
    };
  }

  private createConversationDeletionLease(
    key: string,
    state: ConversationLeaseState,
    token: symbol,
  ): ConversationDeletionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseConversationLease(key, state, token);
      },
    };
  }

  private releaseConversationLease(
    key: string,
    state: ConversationLeaseState,
    token: symbol,
  ): void {
    if (this.leases.get(key) !== state || state.owner !== token) return;

    const waiter = state.waiters.shift();
    if (waiter === undefined) {
      this.leases.delete(key);
      return;
    }

    state.owner = waiter.token;
    this.settleConversationWaiter(waiter);
    waiter.resolve(
      this.createConversationLease(key, state, waiter.token),
    );
  }

  private cancelConversationWaiter(
    key: string,
    state: ConversationLeaseState,
    waiter: ConversationLeaseWaiter,
    error: Error,
  ): void {
    if (waiter.settled || this.leases.get(key) !== state) return;
    const index = state.waiters.indexOf(waiter);
    if (index === -1) return;
    state.waiters.splice(index, 1);
    this.settleConversationWaiter(waiter);
    waiter.reject(error);
  }

  private settleConversationWaiter(waiter: ConversationLeaseWaiter): void {
    waiter.settled = true;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
  }

  private createAbortError(): Error {
    const error = new Error("Conversation lease wait was aborted");
    error.name = "AbortError";
    return error;
  }
}
