import { randomUUID } from "node:crypto";
import {
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
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  ConversationSummary,
  ToolMode,
} from "../shared/protocol.js";
import { validatePiSessionFile } from "./session-file.js";

const MANIFEST_VERSION = 1;
const PROJECT_STATE_DIRECTORY = ".piweb";
const PROJECT_MANIFEST_FILE = "project.json";
const SESSION_DIRECTORY = "sessions";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const DEFAULT_CONVERSATION_LEASE_TIMEOUT_MS = 5_000;

interface ProjectManifestV1 {
  version: typeof MANIFEST_VERSION;
  projectId: string;
  createdAt: string;
  toolMode: ToolMode;
  lastConversationId?: string;
}

export interface ProjectStoreSnapshot {
  id: string;
  cwd: string;
  stateDir: string;
  sessionDir: string;
  toolMode: ToolMode;
  lastConversationId?: string;
  conversations: ConversationSummary[];
}

export interface ConversationLease {
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

export type ProjectStoreListener = (snapshot: ProjectStoreSnapshot) => void;

interface ProjectStoreRegistryEntry {
  opening: Promise<ProjectStore>;
  references: number;
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

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isToolMode(value: unknown): value is ToolMode {
  return value === "read_only" || value === "workspace_write";
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

function parseManifest(raw: string, manifestPath: string): ProjectManifestV1 {
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
    assertToolMode(record.toolMode);
    if (record.lastConversationId !== undefined) {
      assertSessionId(record.lastConversationId, "lastConversationId");
    }

    return {
      version: MANIFEST_VERSION,
      projectId: record.projectId,
      createdAt: record.createdAt,
      toolMode: record.toolMode,
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

export class ProjectStore {
  readonly id: string;
  readonly cwd: string;
  readonly stateDir: string;
  readonly sessionDir: string;

  private readonly manifestPath: string;
  private readonly listeners = new Set<ProjectStoreListener>();
  private manifest: ProjectManifestV1;
  private conversations: ConversationSummary[] = [];
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
    return new ProjectStore(
      canonicalCwd,
      stateDir,
      sessionDir,
      manifestPath,
      manifest,
    );
  }

  get toolMode(): ToolMode {
    return this.manifest.toolMode;
  }

  get lastConversationId(): string | undefined {
    return this.manifest.lastConversationId;
  }

  getSnapshot(): ProjectStoreSnapshot {
    return {
      id: this.id,
      cwd: this.cwd,
      stateDir: this.stateDir,
      sessionDir: this.sessionDir,
      toolMode: this.toolMode,
      ...(this.lastConversationId === undefined
        ? {}
        : { lastConversationId: this.lastConversationId }),
      conversations: this.listConversations(),
    };
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

  setToolMode(toolMode: ToolMode): Promise<void> {
    assertToolMode(toolMode);
    return this.enqueueWrite(async () => {
      if (toolMode === this.manifest.toolMode) return;
      await this.assertStateDirectorySafe();
      const next = { ...this.manifest, toolMode };
      await writeManifestAtomically(this.manifestPath, next);
      this.manifest = next;
      this.emit();
    });
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
    const result = this.refreshTail.then(() => this.scanConversations());
    this.refreshTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async scanConversations(): Promise<ConversationSummary[]> {
    const information = await this.listSafeSessionInformation();
    const conversations = information
      .map(toConversationSummary)
      .sort((first, second) => {
        const byModified =
          Date.parse(second.updatedAt) - Date.parse(first.updatedAt);
        if (byModified !== 0) return byModified;
        return second.id.localeCompare(first.id);
      });

    if (!summariesEqual(this.conversations, conversations)) {
      this.conversations = conversations;
      this.emit();
    }
    return this.listConversations();
  }

  async createConversation(conversationId?: string): Promise<SessionManager> {
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

    await writeFile(sessionFile, `${JSON.stringify(header)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    const conversation = SessionManager.open(
      sessionFile,
      this.sessionDir,
      this.cwd,
    );
    await this.setLastConversation(conversation.getSessionId());
    await this.refreshConversations();
    return conversation;
  }

  async openConversation(conversationId: string): Promise<SessionManager> {
    const information = await this.listSafeSessionInformation();
    const match = information.find(({ id }) => id === conversationId);
    if (match === undefined) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const safePath = await this.resolveSafeSessionPath(match.path);
    validatePiSessionFile(
      await readFile(safePath, "utf8"),
      safePath,
      conversationId,
    );
    const conversation = SessionManager.open(
      safePath,
      this.sessionDir,
      this.cwd,
    );
    if (conversation.getSessionId() !== conversationId) {
      throw new Error(
        `Conversation identity changed while opening: ${conversationId}`,
      );
    }
    await this.setLastConversation(conversationId);
    return conversation;
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
        listener(this.getSnapshot());
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
    const pathsBeforeScan = await this.listSafeSessionPaths();
    const information = await SessionManager.listAll(this.sessionDir);
    const pathsAfterScan = await this.listSafeSessionPaths();
    const beforeIdentities = new Set(pathsBeforeScan.map(pathIdentity));
    const afterIdentities = new Set(pathsAfterScan.map(pathIdentity));
    if (
      beforeIdentities.size !== afterIdentities.size
      || [...beforeIdentities].some((path) => !afterIdentities.has(path))
    ) {
      throw new Error("Project session directory changed while it was being scanned");
    }

    const validatedByPath = new Map<string, string>();
    const pathsByConversation = new Map<string, string>();
    for (const sessionPath of pathsAfterScan) {
      const conversationId = validatePiSessionFile(
        await readFile(sessionPath, "utf8"),
        sessionPath,
      );
      const previousPath = pathsByConversation.get(conversationId);
      if (
        previousPath !== undefined
        && !pathsAreIdentical(previousPath, sessionPath)
      ) {
        throw new Error(
          `Duplicate conversation identity ${conversationId}: ${previousPath} and ${sessionPath}`,
        );
      }
      pathsByConversation.set(conversationId, sessionPath);
      validatedByPath.set(pathIdentity(sessionPath), conversationId);
    }

    const indexedPaths = new Set<string>();
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
    }
    if (indexedPaths.size !== validatedByPath.size) {
      const omittedPath = [...validatedByPath.keys()].find(
        (path) => !indexedPaths.has(path),
      );
      throw new Error(
        `Pi omitted a valid project session file from its index: ${String(omittedPath)}`,
      );
    }
    return information;
  }

  private async listSafeSessionPaths(): Promise<string[]> {
    await this.assertSessionDirectorySafe();
    const entries = await readdir(this.sessionDir, { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl")) continue;
      const entryPath = join(this.sessionDir, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(
          `Session entry must be a regular project-owned file: ${entryPath}`,
        );
      }
      const canonicalPath = await realpath(entryPath);
      if (!pathsAreIdentical(entryPath, canonicalPath)) {
        throw new Error(
          `Session entry resolves outside its project-owned path: ${entryPath} -> ${canonicalPath}`,
        );
      }
      paths.push(canonicalPath);
    }
    await this.assertSessionDirectorySafe();
    return paths;
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
    return {
      release: () => {
        if (released) return;
        released = true;
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
      },
    };
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
