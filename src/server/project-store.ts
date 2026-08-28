import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  link,
  lstat,
  mkdir,
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
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  ConversationSummary,
  ToolMode,
} from "../shared/protocol.js";
import {
  createConversationMetaEntry,
  type ConversationMeta,
} from "./conversation-meta.js";
import { deleteConversationNotebook } from "./conversation-notebook.js";
import {
  inspectPiSessionFile,
  inspectPiSessionFilePresentation,
  validatePiSessionFile,
  type PiSessionFileInspection,
  type PiSessionFilePresentationInspection,
} from "./session-file.js";

const MANIFEST_VERSION = 1;
const PROJECT_STATE_DIRECTORY = ".piweb";
const PROJECT_MANIFEST_FILE = "project.json";
const SESSION_DIRECTORY = "sessions";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const DEFAULT_CONVERSATION_LEASE_TIMEOUT_MS = 5_000;
const MAX_INTEGRITY_PROOF_ATTEMPTS = 8;
const DELETE_QUARANTINE_SUFFIX = ".delete-quarantine";

interface ProjectManifestV1 {
  version: typeof MANIFEST_VERSION;
  projectId: string;
  createdAt: string;
  toolMode: ToolMode;
  lastConversationId?: string;
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

interface VerifiedSessionFileRead {
  path: string;
  raw: string;
  fingerprint: SessionFileFingerprint;
}

interface VerifiedSessionReadBatch {
  catalog: VerifiedSessionCatalog;
  targets: ReadonlyMap<string, VerifiedSessionFileRead>;
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

class SessionDirectoryChangedError extends Error {
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

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isToolMode(value: unknown): value is ToolMode {
  return value === "read_only"
    || value === "full_access";
}

function assertToolMode(value: unknown): asserts value is ToolMode {
  if (!isToolMode(value)) {
    throw new Error(`Invalid tool mode: ${String(value)}`);
  }
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

interface ParsedManifest {
  manifest: ProjectManifestV1;
  migratedLegacyToolMode: boolean;
}

function parseManifest(raw: string, manifestPath: string): ParsedManifest {
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
      "toolMode",
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
    const migratedLegacyToolMode = record.toolMode === "workspace_write";
    const toolMode = migratedLegacyToolMode ? "full_access" : record.toolMode;
    assertToolMode(toolMode);
    if (record.lastConversationId !== undefined) {
      assertSessionId(record.lastConversationId, "lastConversationId");
    }

    return {
      manifest: {
        version: MANIFEST_VERSION,
        projectId: record.projectId,
        createdAt: record.createdAt,
        toolMode,
        ...(record.lastConversationId === undefined
          ? {}
          : { lastConversationId: record.lastConversationId }),
      },
      migratedLegacyToolMode,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid project manifest at ${manifestPath}: ${detail}`, {
      cause: error,
    });
  }
}

async function writeManifestAtomically(
  manifestPath: string,
  manifest: ProjectManifestV1,
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

function validatedSessionVersion(values: readonly unknown[]): number {
  const header = values[0] as { version?: number };
  return header.version ?? 1;
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
  };
}

function toConversationSummaries(
  information: readonly SessionInfo[],
): ConversationSummary[] {
  return information
    .map(toConversationSummary)
    .sort((first, second) => {
      const byModified =
        Date.parse(second.updatedAt) - Date.parse(first.updatedAt);
      if (byModified !== 0) return byModified;
      return second.id.localeCompare(first.id);
    });
}

export class ProjectStore {
  readonly id: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly sessionDir: string;

  private readonly manifestPath: string;
  private readonly listeners = new Set<ProjectStoreListener>();
  private manifest: ProjectManifestV1;
  private conversations: ConversationSummary[] = [];
  private verifiedCatalog?: VerifiedSessionCatalog;
  private writeTail: Promise<void> = Promise.resolve();
  private refreshTail: Promise<void> = Promise.resolve();

  private constructor(
    cwd: string,
    stateDir: string,
    sessionDir: string,
    manifestPath: string,
    manifest: ProjectManifestV1,
  ) {
    this.id = manifest.projectId;
    this.cwd = cwd;
    this.stateDir = stateDir;
    this.sessionDir = sessionDir;
    this.manifestPath = manifestPath;
    this.manifest = manifest;
  }

  static async open(cwd: string, seedToolMode: ToolMode): Promise<ProjectStore> {
    assertToolMode(seedToolMode);
    const canonicalCwd = await canonicalDirectory(cwd);
    const stateDir = join(canonicalCwd, PROJECT_STATE_DIRECTORY);
    const sessionDir = join(stateDir, SESSION_DIRECTORY);
    const manifestPath = join(stateDir, PROJECT_MANIFEST_FILE);
    await mkdir(stateDir, { recursive: true });
    await assertCanonicalOwnedDirectory(stateDir, "Project state directory");

    let manifest: ProjectManifestV1;
    try {
      const parsed = parseManifest(await readFile(manifestPath, "utf8"), manifestPath);
      manifest = parsed.manifest;
      if (parsed.migratedLegacyToolMode) {
        await writeManifestAtomically(manifestPath, manifest);
      }
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
        toolMode: seedToolMode,
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
    return store;
  }

  get toolMode(): ToolMode {
    return this.manifest.toolMode;
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
      const next: ProjectManifestV1 = {
        version: MANIFEST_VERSION,
        projectId: this.manifest.projectId,
        createdAt: this.manifest.createdAt,
        toolMode: this.manifest.toolMode,
        ...(conversationId === undefined
          ? {}
          : { lastConversationId: conversationId }),
      };
      await writeManifestAtomically(this.manifestPath, next);
      this.manifest = next;
      this.emit();
    });
  }

  listConversations(): ConversationSummary[] {
    return this.conversations.map(cloneSummary);
  }

  refreshConversations(): Promise<ConversationSummary[]> {
    return this.enqueueConversationOperation(() => this.scanConversations());
  }

  private async scanConversations(): Promise<ConversationSummary[]> {
    const information = await this.listSafeSessionInformation();
    const conversations = toConversationSummaries(information);
    this.replaceConversations(conversations);
    return this.listConversations();
  }

  private replaceConversations(conversations: ConversationSummary[]): void {
    if (!summariesEqual(this.conversations, conversations)) {
      this.conversations = conversations;
      this.emit();
    }
  }

  async createConversation(
    conversationId?: string,
    conversationMeta?: ConversationMeta,
    options: { updateRecent?: boolean } = {},
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
    let conversation: SessionManager;
    try {
      conversation = SessionManager.open(
        sessionFile,
        this.sessionDir,
        this.cwd,
      );
    } catch (error) {
      try {
        await unlink(sessionFile);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to discard a conversation after its initial SDK open failed",
        );
      }
      throw error;
    }
    if (options.updateRecent !== false) {
      await this.setLastConversation(conversation.getSessionId());
    }
    await this.refreshConversations();
    return conversation;
  }

  async openConversation(
    conversationId: string,
    options: { updateRecent?: boolean } = {},
  ): Promise<SessionManager> {
    const batch = await this.readVerifiedSessionFileBatch([conversationId]);
    const target = batch.targets.get(conversationId)!;
    const preOpenValues = parseValidatedSessionValues(target.raw);
    const preOpenVersion = validatedSessionVersion(preOpenValues);

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
    let expectedFilesAfterOpen: readonly Readonly<SessionFileFingerprint>[] =
      batch.catalog.files;
    if (!fingerprintsEqual(target.fingerprint, afterOpen)) {
      this.verifiedCatalog = undefined;
      if (
        preOpenVersion >= CURRENT_SESSION_VERSION
        || target.fingerprint.dev !== afterOpen.dev
        || target.fingerprint.ino !== afterOpen.ino
      ) {
        throw new SessionFileChangedError(conversationId);
      }

      const postOpen = await this.readStableExpectedSessionFile(
        afterOpen,
        conversationId,
      );
      const postOpenValues = parseValidatedSessionValues(postOpen.raw);
      const postOpenHeader = postOpenValues[0] as { version?: number };
      if (postOpenHeader.version !== CURRENT_SESSION_VERSION) {
        throw new Error(
          `Conversation migration did not produce the current session version: ${conversationId}`,
        );
      }
      if (
        !isDeepStrictEqual(conversation.getHeader(), postOpenValues[0])
        || !isDeepStrictEqual(conversation.getEntries(), postOpenValues.slice(1))
      ) {
        throw new Error(
          `Conversation migration does not match the opened session: ${conversationId}`,
        );
      }
      expectedFilesAfterOpen = batch.catalog.files.map((file) =>
        file.pathKey === target.fingerprint.pathKey ? postOpen.fingerprint : file
      );
    }

    try {
      const filesAfterOpen = await this.listSafeSessionFiles();
      if (!fingerprintSetsEqual(expectedFilesAfterOpen, filesAfterOpen)) {
        throw new SessionDirectoryChangedError(
          `Project session directory changed while conversation ${conversationId} was being opened`,
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
   * Reads host-owned metadata without opening a writable Pi SessionManager or
   * changing the project's recent-conversation pointer.
   */
  async inspectConversation(
    conversationId: string,
  ): Promise<PiSessionFileInspection> {
    const inspections = await this.inspectConversations([conversationId]);
    return inspections.get(conversationId)!;
  }

  /**
   * Opt-in transcript read for one cold presentation target. Metadata callers
   * use inspectConversation(s) and never retain physical session entries.
   */
  async inspectConversationPresentation(
    conversationId: string,
  ): Promise<PiSessionFilePresentationInspection> {
    assertSessionId(conversationId, "conversationId");
    const batch = await this.readVerifiedSessionFileBatch([conversationId]);
    const target = batch.targets.get(conversationId)!;
    return inspectPiSessionFilePresentation(
      target.raw,
      target.path,
      conversationId,
    );
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
      inspections.set(
        conversationId,
        inspectPiSessionFile(
          target.raw,
          target.path,
          conversationId,
        ),
      );
    }
    return inspections;
  }

  deleteConversation(conversationId: string): Promise<void> {
    assertSessionId(conversationId, "conversationId");
    return this.enqueueConversationOperation(async () => {
      await this.recoverAbandonedSessionQuarantines();
      const batch = await this.readVerifiedSessionFileBatch(
        [conversationId],
        { allowMissing: true },
      );
      const target = batch.targets.get(conversationId);
      let quarantined: QuarantinedSessionFile | undefined;

      try {
        if (target !== undefined) {
          quarantined = await this.quarantineSessionFile(
            target,
            conversationId,
          );
        }

        // Quarantine changes the controlled JSONL set, so prove the remaining
        // project before any unrelated durable side effect.
        await this.getVerifiedSessionCatalog(quarantined?.quarantinePath);
        await deleteConversationNotebook(this.stateDir, conversationId);
        await this.clearLastConversationIf(conversationId);

        // Side effects may have yielded to writers. Revalidate all remaining
        // JSONL files before the irreversible quarantine unlink.
        await this.getVerifiedSessionCatalog(quarantined?.quarantinePath);
        if (quarantined !== undefined) {
          await this.readStableExpectedSessionFile(
            quarantined.quarantineFingerprint,
            conversationId,
          );
        }
        if (quarantined !== undefined) {
          await this.unlinkSessionFile(quarantined.quarantinePath);
          quarantined = undefined;
        }

        // A successful delete is projected only from a complete proof taken
        // after the captured quarantine has been unlinked.
        const committedCatalog = await this.getVerifiedSessionCatalog();
        if (
          committedCatalog.information.some(({ id }) => id === conversationId)
        ) {
          throw new Error(
            `Conversation reappeared during deletion: ${conversationId}`,
          );
        }
        this.replaceConversations(toConversationSummaries(
          committedCatalog.information,
        ));
      } catch (error) {
        if (quarantined !== undefined) {
          try {
            await this.recoverQuarantinedSessionFile(quarantined);
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              `Conversation deletion failed and recovery could not be completed: ${conversationId}`,
            );
          }
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
      const next = `${lines.slice(0, entryLine).join("\n")}\n`;
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
      await this.scanConversations();
      return safePath;
    });
  }

  private clearLastConversationIf(conversationId: string): Promise<void> {
    return this.enqueueWrite(async () => {
      if (this.manifest.lastConversationId !== conversationId) return;
      await this.assertStateDirectorySafe();
      const next: ProjectManifestV1 = {
        version: MANIFEST_VERSION,
        projectId: this.manifest.projectId,
        createdAt: this.manifest.createdAt,
        toolMode: this.manifest.toolMode,
      };
      await writeManifestAtomically(this.manifestPath, next);
      this.manifest = next;
      this.emit();
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
    allowedQuarantinePath?: string,
  ): Promise<VerifiedSessionCatalog> {
    for (
      let attempt = 0;
      attempt < MAX_INTEGRITY_PROOF_ATTEMPTS;
      attempt += 1
    ) {
      let currentFiles: SessionFileFingerprint[];
      try {
        currentFiles = await this.listSafeSessionFiles(
          allowedQuarantinePath,
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
          allowedQuarantinePath,
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
    allowedQuarantinePath?: string,
  ): Promise<VerifiedSessionCatalog> {
    const information = await SessionManager.listAll(this.sessionDir);
    const validatedByPath = new Map<string, string>();
    const pathsByConversation = new Map<string, string>();

    for (const file of filesBeforeScan) {
      const beforeRead = await this.fingerprintSafeSessionPath(file.path);
      if (!fingerprintsEqual(file, beforeRead)) {
        throw new SessionDirectoryChangedError();
      }
      const raw = await readFile(file.path, "utf8");
      const afterRead = await this.fingerprintSafeSessionPath(file.path);
      if (!fingerprintsEqual(beforeRead, afterRead)) {
        throw new SessionDirectoryChangedError();
      }
      const conversationId = validatePiSessionFile(raw, file.path);
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
      allowedQuarantinePath,
    );
    if (!fingerprintSetsEqual(filesBeforeScan, filesAfterScan)) {
      throw new SessionDirectoryChangedError();
    }
    // Validate all SDK-derived summary fields before publishing the proof.
    toConversationSummaries(normalizedInformation);

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
    return catalog;
  }

  private async listSafeSessionFiles(
    allowedQuarantinePath?: string,
  ): Promise<SessionFileFingerprint[]> {
    await this.assertSessionDirectorySafe();
    const entries = await readdir(this.sessionDir, { withFileTypes: true });
    const allowedQuarantinePathKey = allowedQuarantinePath === undefined
      ? undefined
      : pathIdentity(allowedQuarantinePath);
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
        if (quarantine.pathKey !== allowedQuarantinePathKey) {
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
      const targets = new Map<string, VerifiedSessionFileRead>();

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

  private async readStableExpectedSessionFile(
    expectedFile: Readonly<SessionFileFingerprint>,
    conversationId: string,
  ): Promise<VerifiedSessionFileRead> {
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
      validatePiSessionFile(raw, afterRead.path, conversationId);
      return { path: afterRead.path, raw, fingerprint: afterRead };
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

  async acquireProject(
    cwd: string,
    seedToolMode: ToolMode,
  ): Promise<ProjectStoreHandle> {
    assertToolMode(seedToolMode);
    const canonicalCwd = await canonicalDirectory(cwd);
    const key = pathIdentity(canonicalCwd);
    const entry = this.getOrCreateProjectEntry(
      key,
      canonicalCwd,
      seedToolMode,
    );
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
    seedToolMode: ToolMode,
  ): ProjectStoreRegistryEntry {
    const existing = this.stores.get(key);
    if (existing !== undefined) return existing;

    const entry: ProjectStoreRegistryEntry = {
      opening: ProjectStore.open(canonicalCwd, seedToolMode),
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
