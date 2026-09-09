import { spawn, type ChildProcess } from "node:child_process";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import picomatch from "picomatch";
import {
  CancellationTokenSource,
  createMessageConnection,
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/lib/node/main.js";
import { LSPErrorCodes, type ServerCapabilities } from "vscode-languageserver-protocol";
import {
  LspError,
  type LspConnection,
  type LspDocumentSelector,
  type LspNotificationMethod,
  type LspRequestMethod,
  type ResolvedLspServer,
} from "./contracts.js";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_DISPOSE_GRACE_MS = 1_000;
const DEFAULT_MAX_PROGRESS_TOKENS = 32;
const MAX_CONFIGURATION_ITEMS = 128;
const MAX_DYNAMIC_REGISTRATIONS = 64;
const MAX_DYNAMIC_WATCHERS = 256;
const MAX_DOCUMENT_FILTERS = 64;
const MAX_REGISTRATION_ID_LENGTH = 256;
const MAX_PROGRESS_TOKEN_LENGTH = 256;
const MAX_GLOB_LENGTH = 1_024;

export interface LspConnectionOptions {
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxPendingRequests?: number;
  readonly maxFrameBytes?: number;
  readonly maxHeaderBytes?: number;
  readonly maxStderrBytes?: number;
  readonly disposeGraceMs?: number;
  readonly maxProgressTokens?: number;
}

interface NormalizedOptions {
  readonly initializeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxPendingRequests: number;
  readonly maxFrameBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxStderrBytes: number;
  readonly disposeGraceMs: number;
  readonly maxProgressTokens: number;
}

type ConnectionState = "initializing" | "live" | "failed" | "disposing" | "disposed";
type FileMatcher = (path: string) => boolean;
type RegisterableMethod = LspRequestMethod | "workspace/didChangeWatchedFiles";

interface Watcher {
  readonly base: string;
  readonly matches: FileMatcher;
  readonly kind: number;
}

interface DocumentFilter {
  readonly language?: string;
  readonly scheme?: string;
  readonly matchesPath?: FileMatcher;
}

interface DynamicRegistration {
  readonly id: string;
  readonly method: RegisterableMethod;
  readonly documentFilters?: readonly DocumentFilter[] | null;
  readonly resolveProvider: boolean;
  readonly watchers?: readonly Watcher[];
}

interface PendingRequest {
  readonly source: CancellationTokenSource;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  removeAbortListener?: () => void;
  timeout?: NodeJS.Timeout;
  callerSettled: boolean;
  wireSettled: boolean;
}

/**
 * Creates one owned LSP process and exposes only the protocol operations that the
 * workspace layer needs. The workspace retains document lifecycle ownership.
 */
export async function createLspConnection(
  server: ResolvedLspServer,
  options: LspConnectionOptions = {},
): Promise<LspConnection> {
  const config = normalizeOptions(options);
  const root = resolve(server.root);
  const rootUri = pathToFileURL(root).href;
  const staticWatchers = server.watchFiles.map((pattern) => createWatcher(root, pattern));
  let child: ChildProcess;

  try {
    child = spawn(server.command[0], [...server.command.slice(1)], {
      cwd: root,
      env: { ...server.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    throw new LspError("unavailable", "Unable to start the LSP server", { cause: error });
  }

  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    child.kill();
    throw new LspError("unavailable", "Unable to create LSP stdio streams");
  }

  const guard = new BoundedLspFrameGuard(config.maxHeaderBytes, config.maxFrameBytes);
  const reader = new StreamMessageReader(guard);
  const writer = new StreamMessageWriter(child.stdin);
  const rpc = createMessageConnection(reader, writer);
  const connection = new StdioLspConnection(
    server,
    root,
    rootUri,
    staticWatchers,
    child,
    guard,
    rpc,
    config,
  );

  connection.bindTransport();
  child.stdout.pipe(guard);
  try {
    await connection.initialize();
    return server.adaptConnection?.(connection) ?? connection;
  } catch (error) {
    await connection.dispose();
    if (error instanceof LspError) throw error;
    throw new LspError("misconfigured", "LSP initialization failed", { cause: error });
  }
}

class StdioLspConnection implements LspConnection {
  private readonly settings: Readonly<Record<string, unknown>>;
  private readonly initializationOptions: Readonly<Record<string, unknown>>;
  private readonly registrations = new Map<string, DynamicRegistration>();
  private readonly pending = new Set<PendingRequest>();
  private readonly progressTokens = new Set<string | number>();
  private readonly stderrChunks: Buffer[] = [];
  private state: ConnectionState = "initializing";
  private capabilitiesValue: ServerCapabilities = Object.freeze({});
  private terminalError?: LspError;
  private disposePromise?: Promise<void>;

  constructor(
    server: ResolvedLspServer,
    private readonly root: string,
    private readonly rootUri: string,
    private readonly staticWatchers: readonly Watcher[],
    private readonly child: ChildProcess,
    private readonly guard: BoundedLspFrameGuard,
    private readonly rpc: MessageConnection,
    private readonly options: NormalizedOptions,
  ) {
    this.settings = snapshot(server.settings) as Readonly<Record<string, unknown>>;
    this.initializationOptions = snapshot(server.initializationOptions) as Readonly<Record<string, unknown>>;
  }

  get capabilities(): ServerCapabilities {
    return this.capabilitiesValue;
  }

  get alive(): boolean {
    return this.state === "live";
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  bindTransport(): void {
    this.guard.on("error", (error: Error) => {
      this.fail(this.unavailable("LSP stdout protocol failure", error));
    });
    this.child.stdout?.on("error", (error: Error) => {
      this.fail(this.unavailable("LSP stdout failed", error));
    });
    this.child.stdin?.on("error", (error: Error) => {
      this.fail(this.unavailable("LSP stdin failed", error));
    });
    this.child.stderr?.on("data", (chunk: Buffer) => this.captureStderr(chunk));
    this.child.on("error", (error: Error) => {
      this.fail(this.unavailable("LSP process failed", error));
    });
    this.child.once("exit", (code, signal) => {
      if (this.state === "disposing" || this.state === "disposed" || this.state === "failed") return;
      const detail = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
      this.fail(this.unavailable(`LSP process exited with ${detail}`));
    });
    this.rpc.onError((error) => {
      this.fail(this.unavailable("LSP JSON-RPC transport failed", error));
    });
    this.rpc.onClose(() => {
      this.fail(this.unavailable("LSP stdout closed"));
    });
    this.rpc.onUnhandledProgress((params) => {
      const value = asRecord(params.value);
      if (value?.kind === "end") this.progressTokens.delete(params.token);
    });
    this.rpc.onRequest((method, params) => this.handleServerRequest(method, params));
  }

  async initialize(): Promise<void> {
    this.rpc.listen();
    const source = new CancellationTokenSource();
    const initialization = this.rpc.sendRequest<unknown>(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "piweb" },
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: basename(this.root) }],
        capabilities: clientCapabilities(),
        initializationOptions: this.initializationOptions,
      },
      source.token,
    );
    initialization.catch(() => undefined);

    let result: unknown;
    try {
      result = await deadline(initialization, this.options.initializeTimeoutMs, () => source.cancel(), () => (
        Promise.reject(new LspError("timeout", "LSP initialization timed out"))
      ));
    } catch (error) {
      if (this.terminalError !== undefined) throw this.terminalError;
      if (error instanceof LspError) throw error;
      throw this.mapProtocolFailure(error);
    } finally {
      source.dispose();
    }

    if (this.terminalError !== undefined) throw this.terminalError;
    const capabilities = initializedCapabilities(result);
    this.capabilitiesValue = snapshot(capabilities) as ServerCapabilities;
    try {
      await this.rpc.sendNotification("initialized", {});
      await this.rpc.sendNotification("workspace/didChangeConfiguration", { settings: this.settings });
    } catch (error) {
      const unavailable = this.unavailable("Unable to finish LSP initialization", error);
      this.fail(unavailable);
      throw unavailable;
    }
    if (this.terminalError !== undefined) throw this.terminalError;
    this.state = "live";
  }

  supports(method: LspRequestMethod, document?: LspDocumentSelector): boolean {
    if (!this.alive) return false;
    if (this.hasStaticCapability(method)) return true;
    for (const registration of this.registrations.values()) {
      if (!registrationSupports(registration, method)) continue;
      if (isDocumentMethod(method) && !documentMatches(registration, document, this.root)) continue;
      return true;
    }
    return false;
  }

  acceptsFileChanges(path: string, type: 1 | 2 | 3 = 2): boolean {
    if (!this.alive) return false;
    const target = resolve(this.root, path);
    const kind = fileChangeKind(type);
    return [...this.staticWatchers, ...this.dynamicWatchers()].some((watcher) => {
      const relativePath = rootedRelativePath(watcher.base, target);
      return relativePath !== undefined && (watcher.kind & kind) !== 0 && watcher.matches(relativePath);
    });
  }

  request(method: LspRequestMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.alive) return Promise.reject(this.currentUnavailable());
    if (!this.dispatchSupports(method)) {
      return Promise.reject(new LspError("unsupported", `LSP server does not support ${method}`));
    }
    if (signal?.aborted) {
      return Promise.reject(new LspError("cancelled", `LSP request ${method} was cancelled before dispatch`));
    }
    if (this.pending.size >= this.options.maxPendingRequests) {
      return Promise.reject(new LspError("resource_limit", "Too many LSP requests are pending"));
    }

    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const entry: PendingRequest = {
        source: new CancellationTokenSource(),
        resolve: resolveRequest,
        reject: rejectRequest,
        callerSettled: false,
        wireSettled: false,
      };
      this.pending.add(entry);
      entry.timeout = setTimeout(() => {
        this.abandonCaller(entry, new LspError("timeout", `LSP request ${method} timed out`));
      }, this.options.requestTimeoutMs);
      if (signal !== undefined) {
        const abort = () => {
          this.abandonCaller(entry, new LspError("cancelled", `LSP request ${method} was cancelled`));
        };
        signal.addEventListener("abort", abort, { once: true });
        entry.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }

      let wire: Promise<unknown>;
      try {
        wire = this.rpc.sendRequest<unknown>(method, params, entry.source.token);
      } catch (error) {
        this.finishWire(entry);
        this.settleCaller(entry, this.mapProtocolFailure(error));
        return;
      }
      wire.then(
        (value) => {
          this.finishWire(entry);
          this.settleCaller(entry, undefined, value);
        },
        (error) => {
          this.finishWire(entry);
          this.settleCaller(entry, this.terminalError ?? this.mapProtocolFailure(error));
        },
      );
    });
  }

  async notify(method: LspNotificationMethod, params: unknown): Promise<void> {
    if (!this.alive) throw this.currentUnavailable();
    try {
      await this.rpc.sendNotification(method, params);
    } catch (error) {
      const unavailable = this.unavailable(`Unable to send LSP notification ${method}`, error);
      this.fail(unavailable);
      throw unavailable;
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    const wasLive = this.state === "live";
    if (this.state !== "failed") this.state = "disposing";
    this.rejectPending(this.currentUnavailable());

    if (wasLive) {
      const source = new CancellationTokenSource();
      try {
        const shutdown = this.rpc.sendRequest<unknown>("shutdown", source.token);
        shutdown.catch(() => undefined);
        await deadline(shutdown, this.options.disposeGraceMs, () => source.cancel(), () => undefined);
        await this.rpc.sendNotification("exit");
      } catch {
        // Shutdown is best effort; owned process cleanup below is authoritative.
      } finally {
        source.dispose();
      }
      await waitForExit(this.child, this.options.disposeGraceMs);
    }

    this.rpc.dispose();
    this.guard.destroy();
    await terminateProcess(this.child, this.options.disposeGraceMs);
    this.state = "disposed";
  }

  private hasStaticCapability(method: LspRequestMethod): boolean {
    const capabilities = this.capabilitiesValue;
    switch (method) {
      case "textDocument/documentSymbol":
        return enabled(capabilities.documentSymbolProvider);
      case "workspace/symbol":
        return enabled(capabilities.workspaceSymbolProvider);
      case "workspaceSymbol/resolve":
        return asRecord(capabilities.workspaceSymbolProvider)?.resolveProvider === true;
      case "textDocument/definition":
        return enabled(capabilities.definitionProvider);
      case "textDocument/references":
        return enabled(capabilities.referencesProvider);
    }
  }

  private dispatchSupports(method: LspRequestMethod): boolean {
    if (!isDocumentMethod(method)) return this.supports(method);
    // Standard document request params contain only a URI, while dynamic
    // selectors may require languageId. Workspace performs the exact selector
    // check before dispatch; this boundary can only verify registration presence.
    return this.hasStaticCapability(method)
      || [...this.registrations.values()].some((registration) => registrationSupports(registration, method));
  }

  private dynamicWatchers(): readonly Watcher[] {
    const watchers: Watcher[] = [];
    for (const registration of this.registrations.values()) {
      if (registration.method === "workspace/didChangeWatchedFiles" && registration.watchers !== undefined) {
        watchers.push(...registration.watchers);
      }
    }
    return watchers;
  }

  private handleServerRequest(method: string, params: unknown): unknown {
    switch (method) {
      case "workspace/configuration":
        return this.configuration(params);
      case "workspace/workspaceFolders":
        return [{ uri: this.rootUri, name: basename(this.root) }];
      case "window/workDoneProgress/create":
        return this.createProgress(params);
      case "client/registerCapability":
        return this.registerCapabilities(params);
      case "client/unregisterCapability":
        return this.unregisterCapabilities(params);
      case "workspace/applyEdit":
        return { applied: false, failureReason: "Pi Web does not apply LSP workspace edits" };
      default:
        return new ResponseError(ErrorCodes.MethodNotFound, `Unsupported LSP client request: ${method}`);
    }
  }

  private configuration(params: unknown): unknown[] | ResponseError<unknown> {
    const items = asRecord(params)?.items;
    if (!Array.isArray(items)) return invalidParams("workspace/configuration requires an items array");
    if (items.length > MAX_CONFIGURATION_ITEMS) return invalidParams("workspace/configuration has too many items");
    return items.map((item) => {
      const record = asRecord(item);
      if (record === undefined || !scopeIsOwned(record.scopeUri, this.root)) return null;
      if (record.section !== undefined && typeof record.section !== "string") return null;
      return configurationValue(this.settings, record.section);
    });
  }

  private createProgress(params: unknown): null | ResponseError<unknown> {
    const token = asRecord(params)?.token;
    if (typeof token === "string") {
      if (token.length > MAX_PROGRESS_TOKEN_LENGTH) {
        return invalidParams("LSP progress token is too long");
      }
    } else if (typeof token !== "number" || !Number.isSafeInteger(token)) {
      return invalidParams("window/workDoneProgress/create requires a string or finite integer token");
    }
    if (this.progressTokens.has(token)) return invalidParams("LSP progress token is already registered");
    if (this.progressTokens.size >= this.options.maxProgressTokens) {
      return new ResponseError(ErrorCodes.InternalError, "LSP progress token limit reached");
    }
    this.progressTokens.add(token);
    return null;
  }

  private registerCapabilities(params: unknown): null | ResponseError<unknown> {
    const registrations = asRecord(params)?.registrations;
    if (!Array.isArray(registrations)) return invalidParams("client/registerCapability requires registrations");
    if (registrations.length > MAX_DYNAMIC_REGISTRATIONS) {
      return invalidParams("Too many LSP capability registrations");
    }
    try {
      const parsed = registrations.map((registration) => this.parseRegistration(registration));
      const ids = new Set<string>();
      for (const registration of parsed) {
        if (ids.has(registration.id) || this.registrations.has(registration.id)) {
          throw new Error(`Duplicate LSP registration ${registration.id}`);
        }
        ids.add(registration.id);
      }
      if (this.registrations.size + parsed.length > MAX_DYNAMIC_REGISTRATIONS) {
        throw new Error("LSP capability registration limit reached");
      }
      const requestedWatchers = parsed.reduce((total, registration) => total + (registration.watchers?.length ?? 0), 0);
      if (this.dynamicWatchers().length + requestedWatchers > MAX_DYNAMIC_WATCHERS) {
        throw new Error("LSP file-watch registration limit reached");
      }
      for (const registration of parsed) this.registrations.set(registration.id, registration);
      return null;
    } catch (error) {
      return invalidParams(error instanceof Error ? error.message : "Invalid LSP capability registration");
    }
  }

  private unregisterCapabilities(params: unknown): null | ResponseError<unknown> {
    const unregisterations = asRecord(params)?.unregisterations;
    if (!Array.isArray(unregisterations)) return invalidParams("client/unregisterCapability requires unregisterations");
    if (unregisterations.length > MAX_DYNAMIC_REGISTRATIONS) {
      return invalidParams("Too many LSP capability unregisterations");
    }
    const targets: Array<{ id: string; method: RegisterableMethod }> = [];
    for (const entry of unregisterations) {
      const record = asRecord(entry);
      if (record === undefined || typeof record.id !== "string" || !isRegisterableMethod(record.method)) {
        return invalidParams("Invalid LSP capability unregistration");
      }
      const existing = this.registrations.get(record.id);
      if (existing === undefined || existing.method !== record.method) {
        return invalidParams(`Unknown LSP registration ${record.id}`);
      }
      targets.push({ id: record.id, method: record.method });
    }
    for (const target of targets) this.registrations.delete(target.id);
    return null;
  }

  private parseRegistration(value: unknown): DynamicRegistration {
    const record = asRecord(value);
    if (record === undefined || typeof record.id !== "string" || record.id.length === 0 ||
      record.id.length > MAX_REGISTRATION_ID_LENGTH || !isRegisterableMethod(record.method)) {
      throw new Error("Invalid LSP capability registration");
    }
    const options = asRecord(record.registerOptions);
    if (record.registerOptions !== undefined && options === undefined) {
      throw new Error("LSP registration options must be an object");
    }
    if (record.method === "workspace/didChangeWatchedFiles") {
      if (options === undefined) throw new Error("LSP file-watch registration requires options");
      return {
        id: record.id,
        method: record.method,
        resolveProvider: false,
        watchers: parseWatchers(options, this.root),
      };
    }
    return {
      id: record.id,
      method: record.method,
      resolveProvider: options?.resolveProvider === true,
      documentFilters: isDocumentMethod(record.method)
        ? parseDocumentFilters(options?.documentSelector)
        : undefined,
    };
  }

  private abandonCaller(entry: PendingRequest, error: LspError): void {
    if (entry.callerSettled || entry.wireSettled) return;
    this.settleCaller(entry, error);
    entry.source.cancel();
  }

  private finishWire(entry: PendingRequest): void {
    if (entry.wireSettled) return;
    entry.wireSettled = true;
    this.pending.delete(entry);
    entry.source.dispose();
  }

  private settleCaller(entry: PendingRequest, error?: unknown, value?: unknown): void {
    if (entry.callerSettled) return;
    entry.callerSettled = true;
    if (entry.timeout !== undefined) clearTimeout(entry.timeout);
    entry.removeAbortListener?.();
    if (error !== undefined) entry.reject(error);
    else entry.resolve(value);
  }

  private rejectPending(error: LspError): void {
    for (const entry of [...this.pending]) {
      entry.source.cancel();
      this.finishWire(entry);
      this.settleCaller(entry, error);
    }
  }

  private fail(error: LspError): void {
    if (this.state === "failed" || this.state === "disposing" || this.state === "disposed") return;
    this.terminalError = error;
    this.state = "failed";
    this.rejectPending(error);
    this.rpc.dispose();
    this.guard.destroy();
    void terminateProcess(this.child, this.options.disposeGraceMs);
  }

  private currentUnavailable(): LspError {
    return this.terminalError ?? this.unavailable("LSP connection is unavailable");
  }

  private unavailable(message: string, cause?: unknown): LspError {
    const stderr = this.stderrText();
    return new LspError("unavailable", stderr === "" ? message : `${message}: ${stderr}`, { cause });
  }

  private mapProtocolFailure(error: unknown): LspError {
    if (error instanceof LspError) return error;
    if (error instanceof ResponseError) {
      switch (error.code) {
        case ErrorCodes.MethodNotFound:
          return new LspError("unsupported", error.message, { cause: error });
        case LSPErrorCodes.ContentModified:
          return new LspError("content_modified", error.message, { cause: error });
        case LSPErrorCodes.RequestCancelled:
          return new LspError("cancelled", error.message, { cause: error });
        default:
          return this.unavailable(`LSP request failed: ${error.message}`, error);
      }
    }
    return this.unavailable("LSP connection failed", error);
  }

  private captureStderr(chunk: Buffer): void {
    const limit = this.options.maxStderrBytes;
    if (chunk.length >= limit) {
      this.stderrChunks.length = 0;
      this.stderrChunks.push(Buffer.from(chunk.subarray(chunk.length - limit)));
      return;
    }
    const combined = Buffer.concat([...this.stderrChunks, chunk]);
    const tail = combined.length > limit ? combined.subarray(combined.length - limit) : combined;
    this.stderrChunks.length = 0;
    this.stderrChunks.push(Buffer.from(tail));
  }

  private stderrText(): string {
    if (this.stderrChunks.length === 0) return "";
    return Buffer.concat(this.stderrChunks).toString("utf8").trim();
  }
}

class BoundedLspFrameGuard extends Transform {
  private header = Buffer.alloc(0);
  private bodyRemaining: number | undefined;

  constructor(
    private readonly maxHeaderBytes: number,
    private readonly maxFrameBytes: number,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.inspect(bytes);
      this.push(bytes);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Invalid LSP frame"));
    }
  }

  private inspect(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.bodyRemaining !== undefined) {
        const consumed = Math.min(this.bodyRemaining, bytes.length - offset);
        this.bodyRemaining -= consumed;
        offset += consumed;
        if (this.bodyRemaining === 0) this.bodyRemaining = undefined;
        continue;
      }

      const remainingHeaderBytes = this.maxHeaderBytes - this.header.length;
      if (remainingHeaderBytes <= 0) throw new Error("LSP header exceeds the configured byte limit");
      const available = Math.min(bytes.length - offset, remainingHeaderBytes);
      const candidate = Buffer.concat([this.header, bytes.subarray(offset, offset + available)]);
      const delimiter = candidate.indexOf("\r\n\r\n", 0, "ascii");
      if (delimiter < 0) {
        if (available < bytes.length - offset) throw new Error("LSP header exceeds the configured byte limit");
        this.header = candidate;
        return;
      }
      const consumed = delimiter + 4 - this.header.length;
      this.header = candidate.subarray(0, delimiter);
      offset += consumed;
      this.bodyRemaining = parseContentLength(this.header, this.maxFrameBytes);
      this.header = Buffer.alloc(0);
      if (this.bodyRemaining === 0) this.bodyRemaining = undefined;
    }
  }
}

function normalizeOptions(options: LspConnectionOptions): NormalizedOptions {
  return {
    initializeTimeoutMs: positiveOption(options.initializeTimeoutMs, DEFAULT_INITIALIZE_TIMEOUT_MS, "initializeTimeoutMs"),
    requestTimeoutMs: positiveOption(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs"),
    maxPendingRequests: positiveOption(options.maxPendingRequests, DEFAULT_MAX_PENDING_REQUESTS, "maxPendingRequests"),
    maxFrameBytes: positiveOption(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes"),
    maxHeaderBytes: positiveOption(options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES, "maxHeaderBytes"),
    maxStderrBytes: positiveOption(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes"),
    disposeGraceMs: positiveOption(options.disposeGraceMs, DEFAULT_DISPOSE_GRACE_MS, "disposeGraceMs"),
    maxProgressTokens: positiveOption(options.maxProgressTokens, DEFAULT_MAX_PROGRESS_TOKENS, "maxProgressTokens"),
  };
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LspError("misconfigured", `${name} must be a positive integer`);
  }
  return value;
}

function parseContentLength(header: Buffer, maxFrameBytes: number): number {
  let contentLength: number | undefined;
  for (const line of header.toString("ascii").split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("LSP header contains an invalid line");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name !== "content-length") continue;
    if (contentLength !== undefined || !/^\d+$/.test(value)) {
      throw new Error("LSP header has an invalid Content-Length");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error("LSP Content-Length is not a safe integer");
    contentLength = parsed;
  }
  if (contentLength === undefined) throw new Error("LSP header is missing Content-Length");
  if (contentLength > maxFrameBytes) throw new Error("LSP frame exceeds the configured byte limit");
  return contentLength;
}

function initializedCapabilities(result: unknown): ServerCapabilities {
  const capabilities = asRecord(asRecord(result)?.capabilities);
  if (capabilities === undefined) {
    throw new LspError("misconfigured", "LSP initialize response did not include capabilities");
  }
  if (capabilities.positionEncoding !== undefined && capabilities.positionEncoding !== "utf-16") {
    throw new LspError("misconfigured", "LSP server selected an unsupported position encoding");
  }
  return capabilities as ServerCapabilities;
}

function clientCapabilities(): Record<string, unknown> {
  return {
    general: { positionEncodings: ["utf-16"] },
    workspace: {
      applyEdit: false,
      configuration: true,
      workspaceFolders: true,
      didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
      symbol: { dynamicRegistration: true, resolveSupport: { properties: ["location.range"] } },
    },
    textDocument: {
      documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
      definition: { dynamicRegistration: true, linkSupport: true },
      references: { dynamicRegistration: true },
    },
    window: { workDoneProgress: true },
  };
}

function enabled(value: unknown): boolean {
  return value !== undefined && value !== false && value !== null;
}

function registrationSupports(registration: DynamicRegistration, method: LspRequestMethod): boolean {
  if (registration.method === method) return true;
  return method === "workspaceSymbol/resolve"
    && registration.method === "workspace/symbol"
    && registration.resolveProvider;
}

function isDocumentMethod(method: LspRequestMethod): boolean {
  return method === "textDocument/documentSymbol"
    || method === "textDocument/definition"
    || method === "textDocument/references";
}

function documentMatches(
  registration: DynamicRegistration,
  document: LspDocumentSelector | undefined,
  root: string,
): boolean {
  if (document === undefined) return false;
  const filters = registration.documentFilters;
  if (filters === undefined || filters === null) return true;
  const path = filePath(document.uri);
  if (path === undefined || rootedRelativePath(root, path) === undefined) return false;
  const relativePath = rootedRelativePath(root, path);
  if (relativePath === undefined) return false;
  const scheme = uriScheme(document.uri);
  return filters.some((filter) => (
    (filter.language === undefined || filter.language === document.languageId)
    && (filter.scheme === undefined || filter.scheme === scheme)
    && (filter.matchesPath === undefined || filter.matchesPath(relativePath))
  ));
}

function parseDocumentFilters(value: unknown): readonly DocumentFilter[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("LSP document selector must be an array or null");
  if (value.length > MAX_DOCUMENT_FILTERS) throw new Error("LSP document selector has too many filters");
  return value.map((item) => {
    const filter = asRecord(item);
    if (filter === undefined) throw new Error("LSP document selector contains an invalid filter");
    if (filter.language !== undefined && typeof filter.language !== "string") {
      throw new Error("LSP document selector language must be a string");
    }
    if (filter.scheme !== undefined && typeof filter.scheme !== "string") {
      throw new Error("LSP document selector scheme must be a string");
    }
    if (filter.pattern !== undefined && typeof filter.pattern !== "string") {
      throw new Error("LSP document selector pattern must be a string");
    }
    return {
      language: filter.language as string | undefined,
      scheme: filter.scheme as string | undefined,
      matchesPath: filter.pattern === undefined ? undefined : compilePattern(filter.pattern),
    };
  });
}

function parseWatchers(options: Record<string, unknown>, root: string): readonly Watcher[] {
  if (!Array.isArray(options.watchers) || options.watchers.length === 0) {
    throw new Error("LSP file-watch registration requires at least one watcher");
  }
  if (options.watchers.length > MAX_DYNAMIC_WATCHERS) {
    throw new Error("LSP file-watch registration has too many watchers");
  }
  return options.watchers.map((value) => {
    const watcher = asRecord(value);
    if (watcher === undefined) throw new Error("LSP file watcher must be an object");
    const kind = watcher.kind === undefined ? 7 : watcher.kind;
    if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0 || kind > 7) {
      throw new Error("LSP file watcher kind must be an integer bitmask from 0 through 7");
    }
    const globPattern = watcher.globPattern;
    if (typeof globPattern === "string") return createWatcher(root, globPattern, kind);
    const relativePattern = asRecord(globPattern);
    if (relativePattern === undefined || typeof relativePattern.pattern !== "string") {
      throw new Error("LSP file watcher has an invalid glob pattern");
    }
    const base = relativePatternBase(relativePattern.baseUri, root);
    return createWatcher(base, relativePattern.pattern, kind);
  });
}

function createWatcher(base: string, pattern: string, kind = 7): Watcher {
  if (pattern.length === 0 || isAbsolute(pattern)) {
    throw new LspError("misconfigured", "LSP watcher glob must be relative and non-empty");
  }
  return { base: resolve(base), matches: compilePattern(pattern), kind };
}

function fileChangeKind(type: 1 | 2 | 3): number {
  return type === 1 ? 1 : type === 2 ? 2 : 4;
}

function compilePattern(pattern: string): FileMatcher {
  if (pattern.length > MAX_GLOB_LENGTH) {
    throw new LspError("misconfigured", "LSP glob must be at most 1024 characters");
  }
  try {
    return picomatch(pattern, { dot: true, nocase: process.platform === "win32" });
  } catch (error) {
    throw new LspError("misconfigured", `Invalid LSP glob pattern ${pattern}`, { cause: error });
  }
}

function relativePatternBase(value: unknown, root: string): string {
  const workspaceFolder = asRecord(value);
  const uri = typeof value === "string" ? value : workspaceFolder?.uri;
  if (typeof uri !== "string") throw new Error("LSP relative pattern requires a file URI base");
  const base = filePath(uri);
  if (base === undefined || !isWithin(root, base)) {
    throw new Error("LSP relative pattern base is outside the workspace root");
  }
  return base;
}

function rootedRelativePath(base: string, target: string): string | undefined {
  const relativePath = relative(resolve(base), resolve(target));
  if (relativePath === "" || !isWithin(base, target)) return undefined;
  return relativePath.replaceAll("\\", "/");
}

function isWithin(base: string, target: string): boolean {
  const relativePath = relative(resolve(base), resolve(target));
  return relativePath === "" || (
    relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

function filePath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

function uriScheme(uri: string): string | undefined {
  try {
    return new URL(uri).protocol.slice(0, -1);
  } catch {
    return undefined;
  }
}

function scopeIsOwned(scopeUri: unknown, root: string): boolean {
  if (scopeUri === undefined || scopeUri === null) return true;
  return typeof scopeUri === "string"
    && (() => {
      const path = filePath(scopeUri);
      return path !== undefined && isWithin(root, path);
    })();
}

function configurationValue(settings: Readonly<Record<string, unknown>>, section: string | undefined): unknown {
  if (section === undefined || section === "") return settings;
  let value: unknown = settings;
  for (const segment of section.split(".")) {
    const record = asRecord(value);
    if (record === undefined || !Object.hasOwn(record, segment)) return null;
    value = record[segment];
  }
  return value ?? null;
}

function isRegisterableMethod(value: unknown): value is RegisterableMethod {
  return value === "textDocument/documentSymbol"
    || value === "workspace/symbol"
    || value === "textDocument/definition"
    || value === "textDocument/references"
    || value === "workspace/didChangeWatchedFiles";
}

function invalidParams(message: string): ResponseError<unknown> {
  return new ResponseError(ErrorCodes.InvalidParams, message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function snapshot(value: unknown): unknown {
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

async function deadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  onTimeout: () => void,
  timeoutValue: () => T | Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          void Promise.resolve(timeoutValue()).then(resolve, reject);
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function terminateProcess(child: ChildProcess, waitMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const taskkill = systemTaskkillPath();
    if (taskkill !== undefined && child.pid !== undefined) {
      await runTaskkill(taskkill, child, waitMs);
    } else {
      signalChild(child, "SIGKILL");
    }
    await waitForExit(child, waitMs);
    return;
  }

  const grouped = signalOwnedProcessGroup(child, "SIGTERM");
  if (grouped) {
    await waitForExit(child, waitMs);
    // The parent may exit after terminating its owned group while a member ignores TERM.
    // This second group signal is still scoped to the group successfully owned at startup.
    signalOwnedProcessGroup(child, "SIGKILL");
    await waitForExit(child, waitMs);
    return;
  }

  signalChild(child, "SIGTERM");
  await waitForExit(child, waitMs);
  if (child.exitCode === null && child.signalCode === null) signalChild(child, "SIGKILL");
  await waitForExit(child, waitMs);
}

function signalOwnedProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the lifecycle check and the signal.
  }
}

function systemTaskkillPath(): string | undefined {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return systemRoot === undefined ? undefined : join(systemRoot, "System32", "taskkill.exe");
}

async function runTaskkill(path: string, child: ChildProcess, waitMs: number): Promise<void> {
  await new Promise<void>((resolveTaskkill) => {
    let killer: ChildProcess | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer?.removeListener("error", onError);
      killer?.removeListener("close", onClose);
      resolveTaskkill();
    };
    const onError = () => {
      child.kill();
      finish();
    };
    const onClose = (code: number | null) => {
      if (code !== 0) child.kill();
      finish();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, waitMs);
    timer.unref?.();
    try {
      killer = spawn(path, ["/pid", String(child.pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      child.kill();
      finish();
      return;
    }
    killer.once("error", onError);
    killer.once("close", onClose);
  });
}

async function waitForExit(child: ChildProcess, waitMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveWait) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveWait();
    };
    const onExit = () => finish();
    const timer = setTimeout(finish, waitMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}
