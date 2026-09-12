import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import chokidar from "chokidar";
import { createLspConnection } from "./connection.js";
import { readWorkspaceFile } from "./read-workspace-file.js";
import {
  LSP_DEFAULT_RESULTS,
  LSP_MAX_RESULTS,
  LspError,
  type LspConnection,
  type LspConnectionFactory,
  type LspDocumentSelector,
  type LspQuery,
  type LspQueryResponse,
  type LspQueryService,
  type LspRequestMethod,
  type ResolvedLspServer,
} from "./contracts.js";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_MAX_ACTIVE_CALLS = 64;
const DEFAULT_MAX_OPEN_DOCUMENTS = 64;
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DOCUMENTS_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_WATCH_EVENTS = 256;
const RECONNECT_COOLDOWN_MS = 1_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type WatchEventName = "add" | "change" | "unlink";

type WorkspaceWatcher = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  add?(paths: string | string[]): unknown;
  close(): Promise<void>;
};

type WorkspaceLspOptions = {
  resolveServer: (canonicalFile: string) => Promise<ResolvedLspServer>;
  createConnection?: LspConnectionFactory;
  timeoutMs?: number;
  idleMs?: number;
  maxConnections?: number;
  maxOpenDocuments?: number;
  maxDocumentBytes?: number;
  maxDocumentsBytes?: number;
  maxWatchEvents?: number;
  watcherFactory?: (
    cwd: string,
    ignored: (path: string) => boolean,
  ) => WorkspaceWatcher;
};

type DiskSnapshot = {
  readonly file: string;
  readonly text: string;
  readonly hash: string;
  readonly bytes: number;
};

type DocumentMirror = {
  readonly file: string;
  text: string;
  hash: string;
  bytes: number;
  readonly uri: string;
  readonly languageId: string;
  version: number;
  lastUsed: number;
};

type SeenFile = {
  readonly file: string;
  hash: string;
  lastUsed: number;
};

type TextSync = {
  readonly openClose: boolean;
  readonly change: 0 | 1 | 2;
  readonly save: false | { includeText: boolean };
};

type WatchChange = {
  readonly id: number;
  readonly path: string;
  readonly key: string;
  readonly event: WatchEventName;
};

type GateWaiter<T> = {
  readonly task: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly deadline: Deadline;
  started: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
};

type PoolEntry = {
  readonly key: string;
  readonly root: string;
  readonly rootKey: string;
  readonly server: ResolvedLspServer;
  readonly fingerprint: string;
  readonly generation: number;
  connection?: LspConnection;
  init?: Promise<LspConnection>;
  borrowers: number;
  queued: number;
  gateActive: boolean;
  readonly gate: Array<GateWaiter<unknown>>;
  invalidated: boolean;
  invalidationError?: LspError;
  closing: boolean;
  idleSince?: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  disposePromise?: Promise<void>;
  readonly documents: Map<string, DocumentMirror>;
  readonly seenFiles: Map<string, SeenFile>;
  documentBytes: number;
  processedWatchId: number;
};

type WatcherState = {
  readonly watcher: WorkspaceWatcher;
  readonly ready: Promise<void>;
  readyObserved: boolean;
  rejectReady?: (error: Error) => void;
};

type RequestDispatch = {
  readonly response: Promise<unknown>;
  readonly releaseSignal: () => void;
  readonly documentVersion?: number;
  readonly watchId: number;
};

class Deadline {
  private readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = Date.now() + timeoutMs;
  }

  get expired(): boolean {
    return this.remaining() <= 0;
  }

  remaining(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  throwIfExpired(): void {
    if (this.expired) throw timeoutError();
  }

  throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw cancelledError();
    this.throwIfExpired();
  }

  wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelledError());
    if (this.expired) return Promise.reject(timeoutError());
    return new Promise<T>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => rejectPromise(cancelledError()));
      const timer = setTimeout(() => finish(() => rejectPromise(timeoutError())), this.remaining());
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => finish(() => resolvePromise(value)),
        (error: unknown) => finish(() => rejectPromise(error)),
      );
    });
  }

  requestSignal(signal: AbortSignal): { signal: AbortSignal; release(): void } {
    const controller = new AbortController();
    const abort = (reason: LspError) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onAbort = () => abort(cancelledError());
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => abort(timeoutError()), this.remaining());
    timer.unref?.();
    return {
      signal: controller.signal,
      release: () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      },
    };
  }
}

function cancelledError(): LspError {
  return new LspError("cancelled", "LSP query was cancelled");
}

function timeoutError(): LspError {
  return new LspError("timeout", "LSP query timed out");
}

function unavailableError(message: string, cause?: unknown): LspError {
  return new LspError("unavailable", message, cause === undefined ? undefined : { cause });
}

function contentModifiedError(): LspError {
  return new LspError("content_modified", "The target changed while the LSP query was in flight");
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isWithin(parent: string, candidate: string): boolean {
  const value = relative(pathKey(parent), pathKey(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function textEnd(text: string): { line: number; character: number } {
  const lines = text.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function textSync(connection: LspConnection): TextSync {
  const configured = connection.capabilities.textDocumentSync;
  if (typeof configured === "number") {
    return {
      openClose: configured !== 0,
      change: configured,
      save: false,
    };
  }
  const change = configured?.change ?? 0;
  const save = configured?.save;
  return {
    openClose: configured?.openClose === true,
    change,
    save: save === true ? { includeText: false } : save ? { includeText: save.includeText === true } : false,
  };
}

function fileChangeType(event: WatchEventName): 1 | 2 | 3 {
  switch (event) {
    case "add":
      return 1;
    case "change":
      return 2;
    case "unlink":
      return 3;
  }
}

function asLspError(error: unknown): LspError {
  if (error instanceof LspError) return error;
  return unavailableError("The LSP server request failed", error);
}

function shouldCooldown(error: unknown): boolean {
  return !(error instanceof LspError) || error.code === "unavailable" || error.code === "timeout";
}

function isWorkspaceSymbolWithoutRange(value: unknown): value is { location: { uri: string } } {
  if (typeof value !== "object" || value === null) return false;
  const location = (value as { location?: unknown }).location;
  if (typeof location !== "object" || location === null) return false;
  return typeof (location as { uri?: unknown }).uri === "string" &&
    !("range" in (location as Record<string, unknown>));
}

/**
 * One workspace-owned LSP pool. It intentionally has no process-global state:
 * roots and servers are meaningful only within the owner workspace.
 */
export class WorkspaceLsp implements LspQueryService {
  private readonly createConnection: LspConnectionFactory;
  private readonly resolveServer: (canonicalFile: string) => Promise<ResolvedLspServer>;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly maxConnections: number;
  private readonly maxOpenDocuments: number;
  private readonly maxDocumentBytes: number;
  private readonly maxDocumentsBytes: number;
  private readonly maxWatchEvents: number;
  private readonly watcherFactory: (
    cwd: string,
    ignored: (path: string) => boolean,
  ) => WorkspaceWatcher;
  private cwdPromise?: Promise<string>;
  private accepting = true;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private generation = 0;
  private readonly entries = new Set<PoolEntry>();
  private readonly currentEntries = new Map<string, PoolEntry>();
  private readonly reconnectCooldowns = new Map<string, number>();
  private readonly retainedPaths = new Map<string, { path: string; count: number }>();
  private watcher?: WatcherState;
  private watcherCwd?: string;
  private readonly watchChanges: WatchChange[] = [];
  private nextWatchId = 0;
  private nextUse = 0;

  constructor(
    private readonly cwd: string,
    options: WorkspaceLspOptions,
  ) {
    this.cwd = normalize(resolve(cwd));
    this.resolveServer = options.resolveServer;
    this.createConnection = options.createConnection ?? createLspConnection;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxOpenDocuments = options.maxOpenDocuments ?? DEFAULT_MAX_OPEN_DOCUMENTS;
    this.maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.maxDocumentsBytes = options.maxDocumentsBytes ?? DEFAULT_MAX_DOCUMENTS_BYTES;
    this.maxWatchEvents = options.maxWatchEvents ?? DEFAULT_MAX_WATCH_EVENTS;
    this.watcherFactory = options.watcherFactory ?? ((root, ignored) =>
      chokidar.watch(root, {
        atomic: true,
        followSymlinks: false,
        ignoreInitial: false,
        ignored,
        persistent: true,
      }) as unknown as WorkspaceWatcher);
  }

  closeAdmission(): void {
    this.accepting = false;
  }

  async query(input: LspQuery, signal: AbortSignal): Promise<LspQueryResponse> {
    const deadline = new Deadline(this.timeoutMs);
    let retainedTarget: string | undefined;
    let entry: PoolEntry | undefined;
    try {
      deadline.throwIfCancelled(signal);
      if (!this.accepting || this.disposed) {
        throw unavailableError("LSP workspace is closing");
      }
      const cwd = await deadline.wait(this.canonicalCwd(), signal);
      const target = await deadline.wait(this.readTarget(cwd, input.path), signal);
      const server = await deadline.wait(this.resolveServer(target.file), signal);
      const root = await deadline.wait(this.canonicalRoot(cwd, server.root), signal);
      if (!isWithin(cwd, root) || !isWithin(root, target.file)) {
        throw new LspError("misconfigured", "The LSP server root does not contain the target in this workspace");
      }
      const languageId = this.languageId(server, target.file);
      const selector = { uri: pathToFileURL(target.file).href, languageId };
      const request = this.requestFor(input, target, selector);
      retainedTarget = target.file;
      this.retainPath(target.file);
      await deadline.wait(this.ensureWatcher(cwd), signal);
      entry = await this.borrow(server, root, deadline, signal);
      if (this.disposed || entry.closing || !entry.connection || !entry.connection.alive) {
        this.invalidate(entry, unavailableError("The LSP server is unavailable"));
        throw unavailableError("The LSP server is unavailable");
      }
      if (!entry.connection.supports(request.method, selector)) {
        throw new LspError("unsupported", `The LSP server does not support ${request.method}`);
      }
      const dispatched = await deadline.wait(this.enqueueGate(entry, signal, deadline, async () => {
        deadline.throwIfCancelled(signal);
        const invalidation = entry!.invalidationError;
        if (invalidation) throw invalidation;
        try {
          await this.assertSnapshotCurrent(entry!, target, deadline);
          const syncState = await this.synchronize(entry!, target, selector, deadline);
          deadline.throwIfCancelled(signal);
          if (entry!.closing || this.disposed) {
            throw unavailableError("The LSP workspace was disposed");
          }
          if (entry!.generation !== this.generation) throw contentModifiedError();
          const requestSignal = deadline.requestSignal(signal);
          let response: Promise<unknown>;
          try {
            response = entry!.connection!.request(request.method, request.params, requestSignal.signal);
          } catch (error) {
            requestSignal.release();
            throw error;
          }
          // Return the response promise as data. Awaiting it here would serialize all RPC responses.
          return {
            response,
            releaseSignal: requestSignal.release,
            documentVersion: syncState.documentVersion,
            watchId: entry!.processedWatchId,
          } satisfies RequestDispatch;
        } catch (error) {
          if (!(error instanceof LspError) || error.code !== "cancelled") this.invalidate(entry!, asLspError(error));
          throw error;
        }
      }), signal);
      let value: unknown;
      try {
        value = await deadline.wait(dispatched.response, signal);
      } catch (error) {
        if (entry.connection && !entry.connection.alive) {
          this.recordReconnectCooldown(entry.key);
          this.invalidate(entry, unavailableError("The LSP server exited"));
        }
        throw error;
      } finally {
        dispatched.releaseSignal();
      }
      if (input.operation === "symbols" && input.scope === "workspace") {
        value = await this.resolveWorkspaceSymbols(
          entry,
          value,
          input.limit === undefined ? LSP_DEFAULT_RESULTS : Math.min(input.limit, LSP_MAX_RESULTS),
          signal,
          deadline,
        );
      }
      await this.assertFresh(entry, target, dispatched, deadline, signal);
      return {
        server: server.id,
        root,
        uri: selector.uri,
        value,
      };
    } catch (error) {
      throw asLspError(error);
    } finally {
      if (entry) this.release(entry);
      if (retainedTarget) this.releasePath(retainedTarget);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.accepting = false;
    this.disposed = true;
    this.reconnectCooldowns.clear();
    const watcher = this.watcher;
    this.watcher = undefined;
    watcher?.rejectReady?.(unavailableError("LSP workspace was disposed"));
    const entries = [...this.entries];
    for (const entry of entries) {
      entry.closing = true;
      this.removeCurrent(entry);
    }
    this.disposePromise = Promise.all([
      watcher?.watcher.close() ?? Promise.resolve(),
      ...entries.map((entry) => this.disposeEntry(entry, true)),
    ]).then(() => undefined);
    return this.disposePromise;
  }

  private canonicalCwd(): Promise<string> {
    this.cwdPromise ??= (async () => {
      try {
        const current = await realpath(this.cwd);
        const info = await stat(current);
        if (!info.isDirectory() || current !== this.cwd) throw new Error("not the owning workspace directory");
        return this.cwd;
      } catch (error) {
        throw new LspError("misconfigured", "The LSP workspace cwd is not an existing directory", { cause: error });
      }
    })();
    return this.cwdPromise;
  }

  private async readTarget(cwd: string, inputPath: string): Promise<DiskSnapshot> {
    const file = await this.canonicalFile(resolve(cwd, inputPath), cwd, "invalid_path");
    return this.readSnapshot(file, cwd);
  }

  private async canonicalRoot(cwd: string, root: string): Promise<string> {
    return this.canonicalDirectory(resolve(cwd, root), cwd);
  }

  private async canonicalDirectory(path: string, cwd: string): Promise<string> {
    try {
      const canonical = await realpath(path);
      const info = await stat(canonical);
      if (!info.isDirectory() || !isWithin(cwd, canonical)) {
        throw new Error("outside workspace or not a directory");
      }
      return canonical;
    } catch (error) {
      throw new LspError("misconfigured", "The LSP server root is not an existing workspace directory", { cause: error });
    }
  }

  private async canonicalFile(path: string, cwd: string, code: "invalid_path" | "content_modified"): Promise<string> {
    try {
      const canonical = await realpath(path);
      const info = await stat(canonical);
      if (!info.isFile() || !isWithin(cwd, canonical)) {
        throw new Error("outside workspace or not a regular file");
      }
      return canonical;
    } catch (error) {
      if (code === "content_modified") throw contentModifiedError();
      throw new LspError("invalid_path", "LSP queries require an existing regular file inside the workspace", { cause: error });
    }
  }

  private async readSnapshot(
    file: string,
    workspace: string,
    code: "invalid_path" | "content_modified" = "invalid_path",
  ): Promise<DiskSnapshot> {
    try {
      const content = await readWorkspaceFile(workspace, file, this.maxDocumentBytes);
      return {
        file,
        text: UTF8_DECODER.decode(content),
        hash: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
      };
    } catch (error) {
      if (error instanceof LspError) {
        if (error.code === "resource_limit" || error.code === "content_modified") throw error;
        if (error.code === "invalid_path" || code === "content_modified") throw contentModifiedError();
        throw error;
      }
      if (code === "content_modified") throw contentModifiedError();
      throw new LspError("invalid_path", "Unable to read a valid UTF-8 LSP target", { cause: error });
    }
  }

  private async assertSnapshotCurrent(
    entry: PoolEntry,
    target: DiskSnapshot,
    deadline: Deadline,
  ): Promise<void> {
    const canonical = await deadline.wait(this.canonicalFile(target.file, entry.root, "content_modified"));
    if (!samePath(canonical, target.file)) throw contentModifiedError();
    const current = await deadline.wait(this.readSnapshot(target.file, entry.root, "content_modified"));
    if (current.hash !== target.hash) throw contentModifiedError();
  }

  private languageId(server: ResolvedLspServer, file: string): string {
    const extension = extname(file).toLowerCase();
    const languageId = server.extensionToLanguage[extension];
    if (!languageId) {
      throw new LspError("misconfigured", `No LSP languageId is configured for ${extension || "this file"}`);
    }
    return languageId;
  }

  private requestFor(
    input: LspQuery,
    target: DiskSnapshot,
    selector: LspDocumentSelector,
  ): { method: LspRequestMethod; params: unknown } {
    if (input.operation === "symbols") {
      if (input.scope === "document") {
        return { method: "textDocument/documentSymbol", params: { textDocument: { uri: selector.uri } } };
      }
      return { method: "workspace/symbol", params: { query: input.query ?? "" } };
    }
    const position = this.position(target.text, input.line, input.column);
    if (input.operation === "definition") {
      return {
        method: "textDocument/definition",
        params: { textDocument: { uri: selector.uri }, position },
      };
    }
    return {
      method: "textDocument/references",
      params: {
        textDocument: { uri: selector.uri },
        position,
        context: { includeDeclaration: input.includeDeclaration ?? false },
      },
    };
  }

  private position(text: string, line: number, column: number): { line: number; character: number } {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) {
      throw new LspError("invalid_path", "LSP positions must be one-based positive integers");
    }
    const lines = text.split("\n");
    const sourceLine = lines[line - 1];
    if (sourceLine === undefined) {
      throw new LspError("invalid_path", "The LSP position line is outside the target");
    }
    const visibleLine = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
    if (column - 1 > visibleLine.length) {
      throw new LspError("invalid_path", "The LSP position column is outside the target line");
    }
    return { line: line - 1, character: column - 1 };
  }

  private async borrow(
    server: ResolvedLspServer,
    root: string,
    deadline: Deadline,
    signal: AbortSignal,
  ): Promise<PoolEntry> {
    if (this.disposed) throw unavailableError("LSP workspace was disposed");
    this.invalidateDifferentFingerprint(root, server.fingerprint);
    const rootKey = pathKey(root);
    const key = JSON.stringify([rootKey, server.fingerprint]);
    let entry = this.currentEntries.get(key);
    if (entry?.connection && !entry.connection.alive) {
      this.recordReconnectCooldown(entry.key);
      this.invalidate(entry, unavailableError("The LSP server exited"));
      throw unavailableError("The LSP server exited");
    }
    if (!entry) {
      this.assertReconnectAllowed(key);
      this.reclaimExpiredEntries();
      if (this.entries.size >= this.maxConnections) {
        throw new LspError("resource_limit", "The LSP connection pool is full");
      }
      entry = {
        key,
        root,
        rootKey,
        server,
        fingerprint: server.fingerprint,
        generation: this.generation,
        borrowers: 0,
        queued: 0,
        gateActive: false,
        gate: [],
        invalidated: false,
        closing: false,
        documents: new Map(),
        seenFiles: new Map(),
        documentBytes: 0,
        processedWatchId: this.nextWatchId,
      };
      this.entries.add(entry);
      this.currentEntries.set(key, entry);
    }
    if (entry.borrowers >= DEFAULT_MAX_ACTIVE_CALLS) {
      throw new LspError("resource_limit", "Too many LSP calls are active for this server");
    }
    entry.borrowers += 1;
    this.clearIdle(entry);
    try {
      const connection = entry.connection ? Promise.resolve(entry.connection) : this.startConnection(entry);
      const resolved = await deadline.wait(connection, signal);
      if (!resolved.alive) {
        this.recordReconnectCooldown(entry.key);
        this.invalidate(entry, unavailableError("The LSP server exited during startup"));
        throw unavailableError("The LSP server exited during startup");
      }
      return entry;
    } catch (error) {
      this.release(entry);
      throw error;
    }
  }

  private startConnection(entry: PoolEntry): Promise<LspConnection> {
    if (entry.connection) return Promise.resolve(entry.connection);
    if (entry.init) return entry.init;
    const init = Promise.resolve().then(() => this.createConnection(entry.server)).then(
      (connection) => {
        entry.connection = connection;
        this.reconnectCooldowns.delete(entry.key);
        return connection;
      },
      (error: unknown) => {
        if (shouldCooldown(error)) this.recordReconnectCooldown(entry.key);
        this.invalidate(entry, asLspError(error));
        throw error;
      },
    );
    entry.init = init;
    void init.then(
      () => {
        if (entry.init === init) entry.init = undefined;
        this.maybeDispose(entry);
      },
      () => {
        if (entry.init === init) entry.init = undefined;
        this.maybeDispose(entry);
      },
    );
    return init;
  }

  private release(entry: PoolEntry): void {
    entry.borrowers -= 1;
    this.maybeDispose(entry);
  }

  private assertReconnectAllowed(key: string): void {
    this.pruneReconnectCooldowns();
    const until = this.reconnectCooldowns.get(key);
    if (until !== undefined) {
      throw unavailableError("The LSP server is cooling down after a failed connection");
    }
    if (this.reconnectCooldowns.size >= this.maxConnections) {
      throw new LspError("resource_limit", "LSP reconnect cooldown capacity is full");
    }
  }

  private recordReconnectCooldown(key: string): void {
    this.pruneReconnectCooldowns();
    if (!this.reconnectCooldowns.has(key) && this.reconnectCooldowns.size >= this.maxConnections) return;
    this.reconnectCooldowns.set(key, Date.now() + RECONNECT_COOLDOWN_MS);
  }

  private pruneReconnectCooldowns(): void {
    const now = Date.now();
    for (const [key, until] of this.reconnectCooldowns) {
      if (until <= now) this.reconnectCooldowns.delete(key);
    }
  }

  private invalidateDifferentFingerprint(root: string, fingerprint: string): void {
    const rootKey = pathKey(root);
    for (const entry of this.entries) {
      if (entry.rootKey === rootKey && entry.fingerprint !== fingerprint) this.retire(entry);
    }
  }

  private retire(entry: PoolEntry): void {
    if (entry.invalidated) return;
    entry.invalidated = true;
    this.removeCurrent(entry);
    this.maybeDispose(entry);
  }

  private invalidate(entry: PoolEntry, error: LspError): void {
    entry.invalidationError ??= error;
    this.retire(entry);
  }

  private removeCurrent(entry: PoolEntry): void {
    if (this.currentEntries.get(entry.key) === entry) this.currentEntries.delete(entry.key);
  }

  private maybeDispose(entry: PoolEntry): void {
    if (entry.disposePromise || entry.borrowers !== 0 || entry.init || entry.queued !== 0) return;
    if (entry.closing || entry.invalidated) {
      void this.disposeEntry(entry).catch(() => undefined);
      return;
    }
    this.clearIdle(entry);
    entry.idleSince = Date.now();
    entry.idleTimer = setTimeout(() => {
      if (entry.idleSince !== undefined && Date.now() - entry.idleSince >= this.idleMs) {
        void this.disposeEntry(entry).catch(() => undefined);
      }
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  private clearIdle(entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.idleSince = undefined;
  }

  private reclaimExpiredEntries(): void {
    for (const entry of this.entries) {
      if (entry.idleSince !== undefined && Date.now() - entry.idleSince >= this.idleMs) {
        void this.disposeEntry(entry).catch(() => undefined);
      }
    }
  }

  private disposeEntry(entry: PoolEntry, force = false): Promise<void> {
    if (entry.disposePromise) return entry.disposePromise;
    if (!force && (entry.borrowers !== 0 || entry.init || entry.queued !== 0)) return Promise.resolve();
    entry.closing = true;
    this.removeCurrent(entry);
    this.clearIdle(entry);
    this.rejectQueued(entry, unavailableError("LSP workspace was disposed"));
    const connection = entry.connection;
    const initialization = entry.init;
    entry.connection = undefined;
    this.releaseDocuments(entry);
    entry.disposePromise = (async () => {
      const initialized = connection ?? await initialization?.catch(() => undefined);
      if (initialized) await initialized.dispose();
    })().finally(() => {
      this.entries.delete(entry);
      this.pruneWatchChanges();
    });
    return entry.disposePromise;
  }

  private rejectQueued(entry: PoolEntry, error: LspError): void {
    for (const waiter of entry.gate.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      entry.queued -= 1;
      waiter.reject(error);
    }
  }

  private releaseDocuments(entry: PoolEntry): void {
    for (const document of entry.documents.values()) this.releasePath(document.file);
    entry.documents.clear();
    entry.seenFiles.clear();
    entry.documentBytes = 0;
  }

  private enqueueGate<T>(
    entry: PoolEntry,
    signal: AbortSignal,
    deadline: Deadline,
    task: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelledError());
    if (deadline.expired) return Promise.reject(timeoutError());
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const waiter: GateWaiter<T> = {
        task,
        resolve: resolvePromise,
        reject: rejectPromise,
        signal,
        deadline,
        started: false,
      };
      const cancel = () => {
        if (waiter.started) return;
        this.removeGateWaiter(entry, waiter as unknown as GateWaiter<unknown>);
        rejectPromise(cancelledError());
      };
      const expire = () => {
        if (waiter.started) return;
        this.removeGateWaiter(entry, waiter as unknown as GateWaiter<unknown>);
        rejectPromise(timeoutError());
      };
      waiter.onAbort = cancel;
      waiter.timer = setTimeout(expire, deadline.remaining());
      waiter.timer.unref?.();
      signal.addEventListener("abort", cancel, { once: true });
      entry.gate.push(waiter as GateWaiter<unknown>);
      entry.queued += 1;
      this.runGate(entry);
    });
  }

  private removeGateWaiter(entry: PoolEntry, waiter: GateWaiter<unknown>): void {
    const index = entry.gate.indexOf(waiter);
    if (index === -1) return;
    entry.gate.splice(index, 1);
    entry.queued -= 1;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    this.maybeDispose(entry);
  }

  private runGate(entry: PoolEntry): void {
    if (entry.gateActive) return;
    const waiter = entry.gate.shift();
    if (!waiter) return;
    entry.gateActive = true;
    waiter.started = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    void (async () => {
      try {
        waiter.deadline.throwIfCancelled(waiter.signal);
        const result = await waiter.task();
        waiter.resolve(result);
      } catch (error) {
        waiter.reject(error);
      } finally {
        entry.queued -= 1;
        entry.gateActive = false;
        this.maybeDispose(entry);
        this.runGate(entry);
      }
    })();
  }

  private async synchronize(
    entry: PoolEntry,
    target: DiskSnapshot,
    selector: LspDocumentSelector,
    deadline: Deadline,
  ): Promise<{ documentVersion?: number }> {
    const connection = entry.connection;
    if (this.disposed || entry.closing || !connection) {
      throw unavailableError("The LSP server is unavailable");
    }
    if (!connection.alive) {
      this.recordReconnectCooldown(entry.key);
      throw unavailableError("The LSP server exited");
    }
    if (entry.generation !== this.generation) throw contentModifiedError();
    const sync = textSync(connection);
    const targetKey = pathKey(target.file);
    try {
      // A watcher change can open a dependency and evict a mirror at capacity. Sync it before
      // the target so the target is the last document made current for this request.
      await this.processWatchChanges(entry, sync, deadline);
      for (const document of [...entry.documents.values()]) {
        if (samePath(document.file, target.file)) continue;
        try {
          const current = await this.readKnownDocument(entry, document, deadline);
          await this.updateDocument(entry, document, current, sync, deadline);
        } catch (error) {
          if (error instanceof LspError && error.code === "content_modified" &&
            !entry.documents.has(pathKey(document.file))) {
            continue;
          }
          throw error;
        }
      }
      await this.assertSnapshotCurrent(entry, target, deadline);
      const existing = entry.documents.get(targetKey);
      if (existing) {
        await this.updateDocument(entry, existing, target, sync, deadline);
      } else if (sync.openClose && sync.change !== 0) {
        await this.openDocument(entry, target, selector, deadline);
      } else {
        const prior = entry.seenFiles.get(targetKey);
        if (prior && prior.hash !== target.hash) {
          if (!connection.acceptsFileChanges(target.file, 2)) {
            throw contentModifiedError();
          }
          await this.notifyWatchedFiles(connection, [{ uri: pathToFileURL(target.file).href, type: 2 }], deadline);
        }
        this.rememberSeenFile(entry, target);
      }
      return { documentVersion: entry.documents.get(targetKey)?.version };
    } catch (error) {
      this.invalidate(entry, asLspError(error));
      throw error;
    }
  }

  private async readKnownDocument(
    entry: PoolEntry,
    document: DocumentMirror,
    deadline: Deadline,
  ): Promise<DiskSnapshot> {
    let canonical: string;
    try {
      canonical = await deadline.wait(this.canonicalFile(document.file, entry.root, "content_modified"));
    } catch (error) {
      if (error instanceof LspError && error.code === "content_modified") {
        await this.closeDocument(entry, document, deadline);
      }
      throw error;
    }
    if (!samePath(canonical, document.file)) {
      await this.closeDocument(entry, document, deadline);
      throw contentModifiedError();
    }
    return deadline.wait(this.readSnapshot(document.file, entry.root, "content_modified"));
  }

  private async openDocument(
    entry: PoolEntry,
    snapshot: DiskSnapshot,
    selector: LspDocumentSelector,
    deadline: Deadline,
  ): Promise<void> {
    if (snapshot.bytes > this.maxDocumentBytes) {
      throw new LspError("resource_limit", "The LSP document exceeds the mirror size limit");
    }
    await this.makeDocumentRoom(entry, snapshot.bytes, deadline);
    if (entry.documents.size >= this.maxOpenDocuments || entry.documentBytes + snapshot.bytes > this.maxDocumentsBytes) {
      throw new LspError("resource_limit", "The LSP document mirror capacity is exhausted");
    }
    const connection = entry.connection!;
    await deadline.wait(connection.notify("textDocument/didOpen", {
      textDocument: {
        uri: selector.uri,
        languageId: selector.languageId,
        version: 1,
        text: snapshot.text,
      },
    }));
    const document: DocumentMirror = {
      ...snapshot,
      uri: selector.uri,
      languageId: selector.languageId,
      version: 1,
      lastUsed: ++this.nextUse,
    };
    entry.documents.set(pathKey(snapshot.file), document);
    entry.documentBytes += snapshot.bytes;
    this.retainPath(snapshot.file);
  }

  private async makeDocumentRoom(entry: PoolEntry, bytes: number, deadline: Deadline): Promise<void> {
    while (entry.documents.size >= this.maxOpenDocuments || entry.documentBytes + bytes > this.maxDocumentsBytes) {
      const oldest = [...entry.documents.values()].sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!oldest) return;
      await this.closeDocument(entry, oldest, deadline);
    }
  }

  private async updateDocument(
    entry: PoolEntry,
    document: DocumentMirror,
    current: DiskSnapshot,
    sync: TextSync,
    deadline: Deadline,
  ): Promise<void> {
    document.lastUsed = ++this.nextUse;
    if (document.hash === current.hash) return;
    if (sync.change === 0) {
      throw contentModifiedError();
    }
    const nextDocumentBytes = entry.documentBytes - document.bytes + current.bytes;
    if (nextDocumentBytes > this.maxDocumentsBytes) {
      throw new LspError("resource_limit", "The LSP document mirror capacity is exhausted");
    }
    const contentChange = sync.change === 1
      ? { text: current.text }
      : {
        range: { start: { line: 0, character: 0 }, end: textEnd(document.text) },
        text: current.text,
      };
    const connection = entry.connection!;
    await deadline.wait(connection.notify("textDocument/didChange", {
      textDocument: { uri: document.uri, version: document.version + 1 },
      contentChanges: [contentChange],
    }));
    if (sync.save) {
      await deadline.wait(connection.notify("textDocument/didSave", {
        textDocument: { uri: document.uri },
        ...(sync.save.includeText ? { text: current.text } : {}),
      }));
    }
    entry.documentBytes = nextDocumentBytes;
    document.text = current.text;
    document.hash = current.hash;
    document.bytes = current.bytes;
    document.version += 1;
  }

  private async closeDocument(entry: PoolEntry, document: DocumentMirror, deadline: Deadline): Promise<void> {
    const sync = textSync(entry.connection!);
    if (!sync.openClose) throw contentModifiedError();
    await deadline.wait(entry.connection!.notify("textDocument/didClose", {
      textDocument: { uri: document.uri },
    }));
    entry.documents.delete(pathKey(document.file));
    entry.documentBytes -= document.bytes;
    this.releasePath(document.file);
  }

  private rememberSeenFile(entry: PoolEntry, snapshot: DiskSnapshot): void {
    const key = pathKey(snapshot.file);
    entry.seenFiles.set(key, { file: snapshot.file, hash: snapshot.hash, lastUsed: ++this.nextUse });
    while (entry.seenFiles.size > this.maxOpenDocuments) {
      const oldest = [...entry.seenFiles.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (!oldest) return;
      entry.seenFiles.delete(oldest[0]);
    }
  }

  private async processWatchChanges(entry: PoolEntry, sync: TextSync, deadline: Deadline): Promise<void> {
    const connection = entry.connection!;
    const watched: Array<{ uri: string; type: 1 | 2 | 3 }> = [];
    const sources: Array<{ path: string; languageId: string }> = [];
    const canSynchronizeDocuments = sync.openClose && sync.change !== 0;
    for (const change of this.watchChanges) {
      if (change.id <= entry.processedWatchId) continue;
      entry.processedWatchId = change.id;
      const type = fileChangeType(change.event);
      if (change.event === "add") {
        if (!connection.acceptsFileChanges(change.path, type)) throw contentModifiedError();
        watched.push({ uri: pathToFileURL(change.path).href, type });
        continue;
      }
      const document = entry.documents.get(change.key);
      if (change.event === "unlink") {
        if (document) await this.closeDocument(entry, document, deadline);
        if (!connection.acceptsFileChanges(change.path, type)) throw contentModifiedError();
        watched.push({ uri: pathToFileURL(change.path).href, type });
        continue;
      }
      if (!canSynchronizeDocuments) {
        if (!connection.acceptsFileChanges(change.path, type)) throw contentModifiedError();
        watched.push({ uri: pathToFileURL(change.path).href, type });
        continue;
      }
      const languageId = entry.server.extensionToLanguage[extname(change.path).toLowerCase()];
      if (!isWithin(entry.root, change.path) || !languageId) {
        if (!connection.acceptsFileChanges(change.path, type)) throw contentModifiedError();
        watched.push({ uri: pathToFileURL(change.path).href, type });
        continue;
      }
      if (connection.acceptsFileChanges(change.path, type)) {
        watched.push({ uri: pathToFileURL(change.path).href, type });
      }
      sources.push({ path: change.path, languageId });
    }
    if (watched.length > 0) await this.notifyWatchedFiles(connection, watched, deadline);
    for (const source of sources) {
      const file = await deadline.wait(this.canonicalFile(source.path, entry.root, "content_modified"));
      if (entry.server.extensionToLanguage[extname(file).toLowerCase()] !== source.languageId) {
        throw contentModifiedError();
      }
      const snapshot = await deadline.wait(this.readSnapshot(file, entry.root, "content_modified"));
      const document = entry.documents.get(pathKey(snapshot.file));
      if (document) {
        await this.updateDocument(entry, document, snapshot, sync, deadline);
      } else {
        await this.openDocument(entry, snapshot, {
          uri: pathToFileURL(file).href,
          languageId: source.languageId,
        }, deadline);
      }
    }
    this.pruneWatchChanges();
  }

  private notifyWatchedFiles(
    connection: LspConnection,
    changes: Array<{ uri: string; type: 1 | 2 | 3 }>,
    deadline: Deadline,
  ): Promise<void> {
    return deadline.wait(connection.notify("workspace/didChangeWatchedFiles", { changes }));
  }

  private async resolveWorkspaceSymbols(
    entry: PoolEntry,
    value: unknown,
    limit: number,
    signal: AbortSignal,
    deadline: Deadline,
  ): Promise<unknown> {
    if (!Array.isArray(value) || !entry.connection?.supports("workspaceSymbol/resolve")) return value;
    const candidates = value
      .map((symbol, index) => ({ symbol, index }))
      .filter(({ symbol }) => isWorkspaceSymbolWithoutRange(symbol))
      .slice(0, limit);
    if (candidates.length === 0) return value;
    const output = [...value];
    for (const { symbol, index } of candidates) {
      output[index] = await this.sendRequest(entry, "workspaceSymbol/resolve", symbol, signal, deadline);
    }
    return output;
  }

  private async sendRequest(
    entry: PoolEntry,
    method: LspRequestMethod,
    params: unknown,
    signal: AbortSignal,
    deadline: Deadline,
  ): Promise<unknown> {
    const control = deadline.requestSignal(signal);
    try {
      const dispatch = await deadline.wait(this.enqueueGate(entry, signal, deadline, async () => {
        deadline.throwIfCancelled(signal);
        const invalidation = entry.invalidationError;
        if (invalidation) throw invalidation;
        const connection = entry.connection;
        if (!connection || !connection.alive || entry.closing || entry.generation !== this.generation) {
          throw unavailableError("The LSP server is unavailable");
        }
        return { response: connection.request(method, params, control.signal) };
      }), signal);
      return await deadline.wait(dispatch.response, signal);
    } finally {
      control.release();
    }
  }

  private async assertFresh(
    entry: PoolEntry,
    target: DiskSnapshot,
    dispatched: RequestDispatch,
    deadline: Deadline,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.disposed || entry.closing) throw unavailableError("The LSP workspace was disposed");
    const invalidation = entry.invalidationError;
    if (invalidation) throw invalidation;
    if (entry.generation !== this.generation) throw contentModifiedError();
    const canonical = await deadline.wait(this.canonicalFile(target.file, entry.root, "content_modified"), signal);
    if (!samePath(canonical, target.file)) throw contentModifiedError();
    const current = await deadline.wait(this.readSnapshot(target.file, entry.root, "content_modified"), signal);
    if (current.hash !== target.hash || this.nextWatchId !== dispatched.watchId) {
      throw contentModifiedError();
    }
    if (dispatched.documentVersion !== undefined &&
      entry.documents.get(pathKey(target.file))?.version !== dispatched.documentVersion) {
      throw contentModifiedError();
    }
    const invalidationAfterFreshness = entry.invalidationError;
    if (invalidationAfterFreshness) throw invalidationAfterFreshness;
  }

  private retainPath(path: string): void {
    const key = pathKey(path);
    const retained = this.retainedPaths.get(key);
    if (retained) {
      retained.count += 1;
      return;
    }
    this.retainedPaths.set(key, { path, count: 1 });
    this.watcher?.watcher.add?.(path);
  }

  private releasePath(path: string): void {
    const key = pathKey(path);
    const retained = this.retainedPaths.get(key);
    if (!retained) return;
    if (retained.count === 1) {
      this.retainedPaths.delete(key);
    } else {
      retained.count -= 1;
    }
  }

  private ensureWatcher(cwd: string): Promise<void> {
    if (this.disposed) return Promise.reject(unavailableError("LSP workspace was disposed"));
    if (this.watcher) return this.watcher.ready;
    this.watcherCwd = cwd;
    let rejectReady!: (error: Error) => void;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    let watcher: WorkspaceWatcher;
    try {
      watcher = this.watcherFactory(cwd, (path) => this.shouldIgnore(path));
    } catch (error) {
      return Promise.reject(unavailableError("Unable to start the LSP workspace watcher", error));
    }
    const state: WatcherState = { watcher, ready, readyObserved: false, rejectReady };
    this.watcher = state;
    watcher.on("all", (event: unknown, path: unknown) => {
      if (this.watcher !== state || !state.readyObserved || typeof event !== "string" || typeof path !== "string") return;
      if (event !== "add" && event !== "change" && event !== "unlink") return;
      this.recordWatchChange(cwd, event, path);
    });
    watcher.on("ready", () => {
      if (this.watcher !== state) return;
      state.readyObserved = true;
      state.rejectReady = undefined;
      resolveReady();
    });
    watcher.on("error", (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failWatcher(state, failure);
    });
    for (const retained of this.retainedPaths.values()) watcher.add?.(retained.path);
    return ready;
  }

  private shouldIgnore(path: string): boolean {
    const cwd = this.watcherCwd;
    if (!cwd) return false;
    const absolute = resolve(cwd, path);
    if (!isWithin(cwd, absolute)) return true;
    for (const retained of this.retainedPaths.values()) {
      if (isWithin(absolute, retained.path)) return false;
    }
    const segments = relative(cwd, absolute).split(/[\\/]/u);
    return segments.includes(".git") || segments.includes(".piweb") || segments.includes("node_modules");
  }

  private recordWatchChange(cwd: string, event: WatchEventName, path: string): void {
    const absolute = resolve(cwd, path);
    if (!isWithin(cwd, absolute)) return;
    if (this.watchChanges.length >= this.maxWatchEvents) {
      this.invalidateGeneration();
      return;
    }
    const key = pathKey(absolute);
    this.nextWatchId += 1;
    this.watchChanges.push({ id: this.nextWatchId, path: absolute, key, event });
  }

  private failWatcher(state: WatcherState, error: Error): void {
    if (this.watcher !== state) return;
    this.watcher = undefined;
    if (!state.readyObserved) state.rejectReady?.(error);
    this.invalidateGeneration();
    void state.watcher.close().catch(() => undefined);
  }

  private invalidateGeneration(): void {
    this.generation += 1;
    this.watchChanges.length = 0;
    for (const entry of this.entries) this.invalidate(entry, contentModifiedError());
  }

  private pruneWatchChanges(): void {
    let minimum = this.nextWatchId;
    for (const entry of this.entries) minimum = Math.min(minimum, entry.processedWatchId);
    while (this.watchChanges.length > 0 && this.watchChanges[0].id <= minimum) {
      this.watchChanges.shift();
    }
  }
}
