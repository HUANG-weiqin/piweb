import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerCapabilities } from "vscode-languageserver-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LspConnection,
  LspConnectionFactory,
  LspNotificationMethod,
  LspRequestMethod,
  ResolvedLspServer,
} from "./contracts.js";
import { LspError } from "./contracts.js";
import { WorkspaceLsp } from "./workspace.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const nativeFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "piweb-lsp-workspace-")));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(nativeFs.open);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeWatcher {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly add = vi.fn();
  readonly close = vi.fn(async () => undefined);

  on(event: string, listener: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeConnection implements LspConnection {
  alive = true;
  pendingCount = 0;
  readonly notifications: Array<{ method: LspNotificationMethod; params: unknown }> = [];
  readonly requests: Array<{ method: LspRequestMethod; params: unknown }> = [];
  readonly dispose = vi.fn(async () => {
    this.alive = false;
  });
  readonly supports = vi.fn(() => true);
  readonly acceptsFileChanges = vi.fn((_path: string, _type: 1 | 2 | 3) => true);
  requestResult: (method: LspRequestMethod, params: unknown) => Promise<unknown> = async () => [];
  notifyResult: (method: LspNotificationMethod, params: unknown) => Promise<void> = async () => undefined;

  constructor(readonly capabilities: ServerCapabilities) {}

  request(method: LspRequestMethod, params: unknown, _signal?: AbortSignal): Promise<unknown> {
    this.requests.push({ method, params });
    return this.requestResult(method, params);
  }

  async notify(method: LspNotificationMethod, params: unknown): Promise<void> {
    this.notifications.push({ method, params });
    await this.notifyResult(method, params);
  }
}

function server(root: string, fingerprint = "config-a"): ResolvedLspServer {
  return {
    id: "typescript",
    root,
    command: ["fake-lsp"],
    env: {},
    extensionToLanguage: { ".ts": "typescript", ".tsx": "typescriptreact" },
    initializationOptions: {},
    settings: {},
    watchFiles: ["**/*"],
    fingerprint,
  };
}

function fakeWorkspace(
  cwd: string,
  connection: FakeConnection,
  options: {
    resolveServer?: (file: string) => Promise<ResolvedLspServer>;
    createConnection?: LspConnectionFactory;
    watcher?: FakeWatcher;
    timeoutMs?: number;
    idleMs?: number;
    maxOpenDocuments?: number;
    maxDocumentBytes?: number;
    maxDocumentsBytes?: number;
    maxWatchEvents?: number;
  } = {},
): WorkspaceLsp {
  const watcher = options.watcher ?? new FakeWatcher();
  return new WorkspaceLsp(cwd, {
    resolveServer: options.resolveServer ?? (async () => server(cwd)),
    createConnection: options.createConnection ?? (async () => connection),
    watcherFactory: () => {
      queueMicrotask(() => watcher.emit("ready"));
      return watcher;
    },
    timeoutMs: options.timeoutMs,
    idleMs: options.idleMs,
    maxOpenDocuments: options.maxOpenDocuments,
    maxDocumentBytes: options.maxDocumentBytes,
    maxDocumentsBytes: options.maxDocumentsBytes,
    maxWatchEvents: options.maxWatchEvents,
  });
}

function symbols(path: string) {
  return {
    operation: "symbols" as const,
    scope: "document" as const,
    path,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const expires = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= expires) throw new Error("Timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("WorkspaceLsp", () => {
  it("shares an initialization that two live callers join before it resolves", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const initialized = deferred<LspConnection>();
    const createConnection = vi.fn(() => initialized.promise);
    const resolveServer = vi.fn(async () => server(cwd));
    const workspace = fakeWorkspace(cwd, connection, { createConnection, resolveServer });

    const first = workspace.query(symbols(file), new AbortController().signal);
    await waitFor(() => createConnection.mock.calls.length === 1);
    const second = workspace.query(symbols(file), new AbortController().signal);
    await waitFor(() => resolveServer.mock.calls.length === 2);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(createConnection).toHaveBeenCalledTimes(1);
    initialized.resolve(connection);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await workspace.dispose();
  });

  it("keeps a joined initialization alive when its first caller cancels", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const initialized = deferred<LspConnection>();
    const createConnection = vi.fn(() => initialized.promise);
    const resolveServer = vi.fn(async () => server(cwd));
    const workspace = fakeWorkspace(cwd, connection, { createConnection, resolveServer });
    const aborter = new AbortController();

    const cancelled = workspace.query(symbols(file), aborter.signal);
    await waitFor(() => createConnection.mock.calls.length === 1);
    const continuing = workspace.query(symbols(file), new AbortController().signal);
    await waitFor(() => resolveServer.mock.calls.length === 2);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    aborter.abort();
    initialized.resolve(connection);

    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    await expect(continuing).resolves.toMatchObject({ server: "typescript" });
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(connection.dispose).not.toHaveBeenCalled();
    await workspace.dispose();
  });

  it("uses one total deadline for a dispatched request without disposing the shared connection", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    connection.requestResult = () => new Promise<never>(() => undefined);
    const workspace = fakeWorkspace(cwd, connection, { timeoutMs: 50 });

    await expect(workspace.query(symbols(file), new AbortController().signal)).rejects.toMatchObject({
      code: "timeout",
    });
    expect(connection.requests).toHaveLength(1);
    expect(connection.dispose).not.toHaveBeenCalled();
    await workspace.dispose();
  });

  it("releases the dispatch gate after sending a request rather than waiting for its response", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const first = deferred<unknown>();
    let requestCount = 0;
    connection.requestResult = () => {
      requestCount += 1;
      return requestCount === 1 ? first.promise : Promise.resolve(["second"]);
    };
    const workspace = fakeWorkspace(cwd, connection);

    const slow = workspace.query(symbols(file), new AbortController().signal);
    await waitFor(() => connection.requests.length === 1);
    await expect(workspace.query(symbols(file), new AbortController().signal)).resolves.toMatchObject({
      value: ["second"],
    });
    expect(connection.requests).toHaveLength(2);

    first.resolve(["first"]);
    await expect(slow).resolves.toMatchObject({ value: ["first"] });
    await workspace.dispose();
  });

  it.each([
    [1, "full"],
    [2, "incremental"],
  ] as const)("synchronizes external disk writes with %s document sync", async (sync, mode) => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "const before = 'x';\r\n");
    const connection = new FakeConnection({ textDocumentSync: sync });
    const workspace = fakeWorkspace(cwd, connection);

    await workspace.query(symbols(file), new AbortController().signal);
    await writeFile(file, "const after = '😀';\r\n");
    await workspace.query(symbols(file), new AbortController().signal);

    const change = connection.notifications.find((notification) => notification.method === "textDocument/didChange");
    expect(change).toBeDefined();
    const contentChange = (change?.params as { contentChanges: Array<Record<string, unknown>> }).contentChanges[0];
    expect(contentChange.text).toBe("const after = '😀';\r\n");
    if (mode === "full") {
      expect(contentChange.range).toBeUndefined();
    } else {
      expect(contentChange.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      });
    }
    await workspace.dispose();
  });

  it("invalidates a no-sync connection when a known target changes without watched-file support", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "const before = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 0 });
    connection.acceptsFileChanges.mockImplementation((_path, type) => type === 1);
    const workspace = fakeWorkspace(cwd, connection);

    await workspace.query(symbols(file), new AbortController().signal);
    await writeFile(file, "const after = 2;\n");

    await expect(workspace.query(symbols(file), new AbortController().signal)).rejects.toMatchObject({
      code: "content_modified",
    });
    expect(connection.acceptsFileChanges).toHaveBeenCalledWith(file, 2);
    await workspace.dispose();
  });

  it.each([
    ["add", 1],
    ["change", 2],
    ["unlink", 3],
  ] as const)("checks %s events against their exact watched-file kind", async (event, type) => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    const extra = join(cwd, "project.fixture");
    await writeFile(file, "export const value = 1;\n");
    if (event !== "add") await writeFile(extra, "before");
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    connection.acceptsFileChanges.mockImplementation((_path, kind) => kind === 1);
    const workspace = fakeWorkspace(cwd, connection, { watcher });
    try {
      await workspace.query(symbols(file), new AbortController().signal);
      if (event === "unlink") await rm(extra);
      else await writeFile(extra, "after");
      watcher.emit("all", event, extra);

      const query = workspace.query(symbols(file), new AbortController().signal);
      if (type === 1) {
        await expect(query).resolves.toMatchObject({ server: "typescript" });
        expect(connection.notifications).toContainEqual(expect.objectContaining({
          method: "workspace/didChangeWatchedFiles",
          params: { changes: [{ uri: expect.stringContaining("project.fixture"), type }] },
        }));
      } else {
        await expect(query).rejects.toMatchObject({ code: "content_modified" });
        expect(connection.requests).toHaveLength(1);
      }
      expect(connection.acceptsFileChanges).toHaveBeenCalledWith(extra, type);
    } finally {
      await workspace.dispose();
    }
  });

  it("rejects out-of-workspace paths and invalid UTF-16 positions", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    const external = join(outside, "outside.ts");
    await writeFile(file, "😀\r\nnext\n");
    await writeFile(external, "export const external = true;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = fakeWorkspace(cwd, connection);

    await expect(workspace.query(symbols(external), new AbortController().signal)).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(workspace.query({
      operation: "definition",
      path: file,
      line: 1,
      column: 4,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_path" });
    await expect(workspace.query({
      operation: "definition",
      path: file,
      line: 1,
      column: 3,
    }, new AbortController().signal)).resolves.toMatchObject({
      value: [],
    });
    await workspace.dispose();
  });

  it("rejects a whole workspace replacement before configuration, connection, or an external fd read", async () => {
    const parent = await temporaryDirectory();
    const cwd = join(parent, "workspace");
    const original = join(parent, "original");
    const outside = await temporaryDirectory();
    const internal = join(cwd, "entry.ts");
    const external = join(outside, "entry.ts");
    await mkdir(cwd);
    await Promise.all([
      writeFile(internal, "export const internal = true;\n"),
      writeFile(external, "export const external = true;\n"),
    ]);
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const resolveServer = vi.fn(async () => server(cwd));
    const createConnection = vi.fn(async () => connection);
    const workspace = fakeWorkspace(cwd, connection, { resolveServer, createConnection });
    let externalRead: ReturnType<typeof vi.fn> | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[0] === external) {
        const handle = await nativeFs.open(...args);
        externalRead = vi.spyOn(handle, "read");
        return handle;
      }
      return nativeFs.open(...args);
    });
    await rename(cwd, original);
    await symlink(outside, cwd, process.platform === "win32" ? "junction" : "dir");

    try {
      const result = await workspace.query(symbols("entry.ts"), new AbortController().signal).catch((error: unknown) => error);
      expect(externalRead).toBeUndefined();
      expect(resolveServer).not.toHaveBeenCalled();
      expect(createConnection).not.toHaveBeenCalled();
      expect(result).toMatchObject({ code: "misconfigured" });
    } finally {
      await workspace.dispose();
    }
  });

  it("rechecks a target snapshot after delayed initialization before any sync notification or request", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const initialized = deferred<LspConnection>();
    const createConnection = vi.fn(() => initialized.promise);
    const workspace = fakeWorkspace(cwd, connection, { createConnection });

    const stale = workspace.query(symbols(file), new AbortController().signal);
    await waitFor(() => createConnection.mock.calls.length === 1);
    await writeFile(file, "export const value = 2;\n");
    initialized.resolve(connection);

    await expect(stale).rejects.toMatchObject({ code: "content_modified" });
    expect(connection.notifications).toHaveLength(0);
    expect(connection.requests).toHaveLength(0);
    await workspace.dispose();
  });

  it("rechecks a queued target snapshot before it can publish an old didOpen", async () => {
    const cwd = await temporaryDirectory();
    const first = join(cwd, "first.ts");
    const second = join(cwd, "second.ts");
    await writeFile(first, "export const first = 1;\n");
    await writeFile(second, "export const second = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const firstOpen = deferred<void>();
    const leadingResponse = deferred<unknown>();
    connection.notifyResult = (_method, params) => {
      const uri = (params as { textDocument?: { uri?: string } }).textDocument?.uri;
      return uri?.endsWith("first.ts") ? firstOpen.promise : Promise.resolve();
    };
    connection.requestResult = () => leadingResponse.promise;
    const resolveServer = vi.fn(async () => server(cwd));
    const workspace = fakeWorkspace(cwd, connection, { resolveServer });

    const leading = workspace.query(symbols(first), new AbortController().signal);
    await waitFor(() => connection.notifications.some(({ method }) => method === "textDocument/didOpen"));
    const queued = workspace.query(symbols(second), new AbortController().signal);
    const queuedResult = queued.catch((error: unknown) => error);
    await waitFor(() => resolveServer.mock.calls.length === 2);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await writeFile(second, "export const second = 2;\n");
    firstOpen.resolve();

    await expect(queuedResult).resolves.toMatchObject({ code: "content_modified" });
    leadingResponse.resolve([]);
    await expect(leading).rejects.toMatchObject({ code: "content_modified" });
    expect(connection.notifications.filter(({ method }) => method === "textDocument/didOpen")).toHaveLength(1);
    await workspace.dispose();
  });

  it("bounds source reads before startup, rejects invalid UTF-8, and preserves a UTF-8 BOM", async () => {
    const cwd = await temporaryDirectory();
    const oversized = join(cwd, "oversized.ts");
    await writeFile(oversized, "12345");
    const connection = new FakeConnection({ textDocumentSync: 0 });
    const createConnection = vi.fn(async () => connection);
    const oversizedWorkspace = fakeWorkspace(cwd, connection, {
      createConnection,
      maxDocumentBytes: 4,
    });

    await expect(oversizedWorkspace.query(symbols(oversized), new AbortController().signal)).rejects.toMatchObject({
      code: "resource_limit",
    });
    expect(createConnection).not.toHaveBeenCalled();
    expect(connection.requests).toHaveLength(0);
    await oversizedWorkspace.dispose();

    const invalid = join(cwd, "invalid.ts");
    await writeFile(invalid, Buffer.from([0xff]));
    const invalidFactory = vi.fn(async () => connection);
    const invalidWorkspace = fakeWorkspace(cwd, connection, { createConnection: invalidFactory });
    await expect(invalidWorkspace.query(symbols(invalid), new AbortController().signal)).rejects.toMatchObject({
      code: "invalid_path",
    });
    expect(invalidFactory).not.toHaveBeenCalled();
    await invalidWorkspace.dispose();

    const bom = join(cwd, "bom.ts");
    await writeFile(bom, Buffer.from([0xef, 0xbb, 0xbf, 0x78, 0x0a]));
    const bomConnection = new FakeConnection({ textDocumentSync: 1 });
    const bomWorkspace = fakeWorkspace(cwd, bomConnection);
    await bomWorkspace.query({
      operation: "definition",
      path: bom,
      line: 1,
      column: 2,
    }, new AbortController().signal);
    expect(bomConnection.requests[0].params).toMatchObject({
      position: { line: 0, character: 1 },
    });
    await bomWorkspace.dispose();
  });

  it("rejects an initial target replaced by an external directory symlink before its fd is read", async () => {
    const cwd = await temporaryDirectory();
    const directory = join(cwd, "nested");
    const target = join(directory, "target.ts");
    const outside = await temporaryDirectory();
    await Promise.all([
      mkdir(directory),
      writeFile(join(outside, "target.ts"), "export const external = true;\n"),
    ]);
    await writeFile(target, "export const internal = true;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const createConnection = vi.fn(async () => connection);
    const workspace = fakeWorkspace(cwd, connection, { createConnection });
    let externalRead: ReturnType<typeof vi.fn> | undefined;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      expect(args[0]).toBe(target);
      await rename(directory, join(cwd, "original"));
      await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
      const handle = await nativeFs.open(...args);
      externalRead = vi.spyOn(handle, "read");
      return handle;
    });

    try {
      await expect(workspace.query(symbols(target), new AbortController().signal)).rejects.toMatchObject({
        code: "content_modified",
      });
      expect(externalRead).toBeDefined();
      expect(externalRead).not.toHaveBeenCalled();
      expect(createConnection).not.toHaveBeenCalled();
    } finally {
      await workspace.dispose();
    }
  });

  it("fails closed when a later mirror read opens a replaced directory", async () => {
    const cwd = await temporaryDirectory();
    const directory = join(cwd, "nested");
    const mirrored = join(directory, "mirrored.ts");
    const target = join(cwd, "entry.ts");
    const outside = await temporaryDirectory();
    await Promise.all([
      mkdir(directory),
      writeFile(target, "export const entry = true;\n"),
      writeFile(join(outside, "mirrored.ts"), "export const external = true;\n"),
    ]);
    await writeFile(mirrored, "export const internal = true;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = fakeWorkspace(cwd, connection);

    try {
      await workspace.query(symbols(mirrored), new AbortController().signal);
      let replaced = false;
      let externalRead: ReturnType<typeof vi.fn> | undefined;
      vi.mocked(open).mockImplementation(async (...args) => {
        if (!replaced && args[0] === mirrored) {
          replaced = true;
          await rename(directory, join(cwd, "original"));
          await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
          const handle = await nativeFs.open(...args);
          externalRead = vi.spyOn(handle, "read");
          return handle;
        }
        return nativeFs.open(...args);
      });

      await expect(workspace.query(symbols(target), new AbortController().signal)).rejects.toMatchObject({
        code: "content_modified",
      });
      expect(replaced).toBe(true);
      expect(externalRead).toBeDefined();
      expect(externalRead).not.toHaveBeenCalled();
      expect(connection.requests).toHaveLength(1);
    } finally {
      await workspace.dispose();
    }
  });

  it("notifies a no-sync server about a changed previously seen file while querying another file", async () => {
    const cwd = await temporaryDirectory();
    const first = join(cwd, "first.ts");
    const second = join(cwd, "second.ts");
    await writeFile(first, "export const first = 1;\n");
    await writeFile(second, "export const second = 1;\n");
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 0 });
    const workspace = fakeWorkspace(cwd, connection, { watcher });

    await workspace.query(symbols(first), new AbortController().signal);
    await writeFile(first, "export const first = 2;\n");
    watcher.emit("all", "change", first);
    await workspace.query(symbols(second), new AbortController().signal);

    expect(connection.notifications).toContainEqual(expect.objectContaining({
      method: "workspace/didChangeWatchedFiles",
      params: expect.objectContaining({
        changes: expect.arrayContaining([expect.objectContaining({ type: 2 })]),
      }),
    }));
    await workspace.dispose();
  });

  it("synchronizes an unopened changed source with its latest text before the dependent request", async () => {
    const cwd = await temporaryDirectory();
    const entry = join(cwd, "entry.ts");
    const dependency = join(cwd, "dependency.ts");
    const latest = "export const dependency = 'latest';\n";
    await Promise.all([
      writeFile(entry, "export const entry = dependency;\n"),
      writeFile(dependency, "export const dependency = 'old';\n"),
    ]);
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    let requests = 0;
    connection.requestResult = async () => {
      requests += 1;
      if (requests === 2) {
        const open = connection.notifications.find(({ method, params }) => method === "textDocument/didOpen" &&
          (params as { textDocument: { uri: string } }).textDocument.uri.endsWith("dependency.ts"));
        expect(open).toMatchObject({
          params: { textDocument: { text: latest } },
        });
      }
      return [];
    };
    const workspace = fakeWorkspace(cwd, connection, { watcher });

    await workspace.query(symbols(entry), new AbortController().signal);
    await writeFile(dependency, latest);
    watcher.emit("all", "change", dependency);
    await workspace.query(symbols(entry), new AbortController().signal);

    expect(connection.notifications).toContainEqual(expect.objectContaining({
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [{ uri: expect.stringContaining("dependency.ts"), type: 2 }] },
    }));
    await workspace.dispose();
  });

  it("leaves the requested target open with its latest text when a dirty dependency exhausts the mirror", async () => {
    const cwd = await temporaryDirectory();
    const entry = join(cwd, "entry.ts");
    const dependency = join(cwd, "dependency.ts");
    const entryLatest = "export const entry = 'latest';\n";
    await Promise.all([
      writeFile(entry, "export const entry = 'old';\n"),
      writeFile(dependency, "export const dependency = 'old';\n"),
    ]);
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    let requests = 0;
    connection.requestResult = async () => {
      requests += 1;
      if (requests === 2) {
        const entryEvents = connection.notifications.filter(({ method, params }) =>
          (method === "textDocument/didOpen" || method === "textDocument/didChange" || method === "textDocument/didClose") &&
          (params as { textDocument: { uri: string } }).textDocument.uri.endsWith("entry.ts"));
        expect(entryEvents.at(-1)).toMatchObject({
          method: "textDocument/didOpen",
          params: { textDocument: { text: entryLatest } },
        });
      }
      return [];
    };
    const workspace = fakeWorkspace(cwd, connection, { watcher, maxOpenDocuments: 1 });

    await workspace.query(symbols(entry), new AbortController().signal);
    await Promise.all([
      writeFile(entry, entryLatest),
      writeFile(dependency, "export const dependency = 'latest';\n"),
    ]);
    watcher.emit("all", "change", dependency);
    await workspace.query(symbols(entry), new AbortController().signal);

    const entryOpens = connection.notifications.filter(({ method, params }) => method === "textDocument/didOpen" &&
      (params as { textDocument: { uri: string } }).textDocument.uri.endsWith("entry.ts"));
    expect(entryOpens).toHaveLength(2);
    await workspace.dispose();
  });

  it("retains add and unlink membership notifications when the file has an open mirror", async () => {
    const cwd = await temporaryDirectory();
    const entry = join(cwd, "entry.ts");
    const member = join(cwd, "member.ts");
    await Promise.all([
      writeFile(entry, "export const entry = 1;\n"),
      writeFile(member, "export const member = 1;\n"),
    ]);
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = fakeWorkspace(cwd, connection, { watcher });

    await workspace.query(symbols(entry), new AbortController().signal);
    await workspace.query(symbols(member), new AbortController().signal);
    watcher.emit("all", "add", member);
    await rm(member);
    watcher.emit("all", "unlink", member);
    await workspace.query(symbols(entry), new AbortController().signal);

    expect(connection.notifications).toContainEqual(expect.objectContaining({
      method: "workspace/didChangeWatchedFiles",
      params: { changes: [
        { uri: expect.stringContaining("member.ts"), type: 1 },
        { uri: expect.stringContaining("member.ts"), type: 3 },
      ] },
    }));
    expect(connection.notifications).toContainEqual(expect.objectContaining({
      method: "textDocument/didClose",
      params: { textDocument: { uri: expect.stringContaining("member.ts") } },
    }));
    await workspace.dispose();
  });

  it.each([
    ["missing", "content_modified", async (_path: string) => undefined],
    ["oversized", "resource_limit", async (path: string) => writeFile(path, "12345")],
  ])("does not bypass bounded source validation for a %s watched source", async (_kind, code, prepare) => {
    const cwd = await temporaryDirectory();
    const entry = join(cwd, "entry.ts");
    const dependency = join(cwd, "dependency.ts");
    await writeFile(entry, "x\n");
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = fakeWorkspace(cwd, connection, { watcher, maxDocumentBytes: 4 });

    await workspace.query(symbols(entry), new AbortController().signal);
    await prepare(dependency);
    watcher.emit("all", "change", dependency);

    await expect(workspace.query(symbols(entry), new AbortController().signal)).rejects.toMatchObject({ code });
    expect(connection.notifications.filter(({ method }) => method === "textDocument/didOpen")).toHaveLength(1);
    expect(connection.requests).toHaveLength(1);
    await workspace.dispose();
  });

  it("rejects a document growth that would exceed aggregate mirror capacity before didChange", async () => {
    const cwd = await temporaryDirectory();
    const first = join(cwd, "first.ts");
    const second = join(cwd, "second.ts");
    await writeFile(first, "aaaa");
    await writeFile(second, "bbbb");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = fakeWorkspace(cwd, connection, { maxDocumentsBytes: 10 });

    await workspace.query(symbols(first), new AbortController().signal);
    await workspace.query(symbols(second), new AbortController().signal);
    const changesBefore = connection.notifications.filter(({ method }) => method === "textDocument/didChange").length;
    await writeFile(first, "aaaaaaa");

    await expect(workspace.query(symbols(first), new AbortController().signal)).rejects.toMatchObject({
      code: "resource_limit",
    });
    expect(connection.notifications.filter(({ method }) => method === "textDocument/didChange")).toHaveLength(changesBefore);
    await workspace.dispose();
  });

  it.each([
    ["unavailable", true],
    ["timeout", true],
    ["misconfigured", false],
  ] as const)("applies cooldown to %s initialization failures only when appropriate", async (failure, cooldown) => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    let factoryCalls = 0;
    const createConnection = vi.fn(async () => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new LspError(failure, "startup failed");
      return connection;
    });
    const workspace = fakeWorkspace(cwd, connection, { createConnection });
    let now = 20_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(workspace.query(symbols(file), new AbortController().signal)).rejects.toMatchObject({
        code: failure,
      });
      if (cooldown) {
        await expect(workspace.query(symbols(file), new AbortController().signal)).rejects.toMatchObject({
          code: "unavailable",
        });
        expect(createConnection).toHaveBeenCalledTimes(1);
        now += 1_001;
      }
      await expect(workspace.query(symbols(file), new AbortController().signal)).resolves.toMatchObject({
        server: "typescript",
      });
      expect(createConnection).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      await workspace.dispose();
    }
  });

  it("cools down only a failed root and reconnects once its cooldown expires", async () => {
    const cwd = await temporaryDirectory();
    const firstRoot = join(cwd, "first");
    const secondRoot = join(cwd, "second");
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    const firstFile = join(firstRoot, "first.ts");
    const secondFile = join(secondRoot, "second.ts");
    await Promise.all([
      writeFile(firstFile, "export const first = 1;\n"),
      writeFile(secondFile, "export const second = 1;\n"),
    ]);
    const first = new FakeConnection({ textDocumentSync: 1 });
    const second = new FakeConnection({ textDocumentSync: 1 });
    const reconnected = new FakeConnection({ textDocumentSync: 1 });
    let factoryCalls = 0;
    const createConnection = vi.fn(async () => [first, second, reconnected][factoryCalls++]);
    const workspace = fakeWorkspace(cwd, first, {
      createConnection,
      resolveServer: async (file) => server(file === firstFile ? firstRoot : secondRoot),
    });
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await workspace.query(symbols(firstFile), new AbortController().signal);
      first.alive = false;
      await expect(workspace.query(symbols(firstFile), new AbortController().signal)).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(workspace.query(symbols(secondFile), new AbortController().signal)).resolves.toMatchObject({
        root: secondRoot,
      });
      await expect(workspace.query(symbols(firstFile), new AbortController().signal)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(createConnection).toHaveBeenCalledTimes(2);

      now += 1_001;
      await expect(workspace.query(symbols(firstFile), new AbortController().signal)).resolves.toMatchObject({
        root: firstRoot,
      });
      expect(createConnection).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
      await workspace.dispose();
    }
  });

  it("rebuilds after a watcher error instead of reusing the old generation", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const firstWatcher = new FakeWatcher();
    const secondWatcher = new FakeWatcher();
    const createConnection = vi.fn(async () => new FakeConnection({ textDocumentSync: 1 }));
    let watcherCount = 0;
    const workspace = new WorkspaceLsp(cwd, {
      resolveServer: async () => server(cwd),
      createConnection,
      watcherFactory: () => {
        const watcher = watcherCount++ === 0 ? firstWatcher : secondWatcher;
        queueMicrotask(() => watcher.emit("ready"));
        return watcher;
      },
    });

    await workspace.query(symbols(file), new AbortController().signal);
    firstWatcher.emit("error", new Error("watch failed"));
    await workspace.query(symbols(file), new AbortController().signal);

    expect(createConnection).toHaveBeenCalledTimes(2);
    await workspace.dispose();
  });

  it("ignores a retired watcher's late change event", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const firstWatcher = new FakeWatcher();
    const secondWatcher = new FakeWatcher();
    const first = new FakeConnection({ textDocumentSync: 1 });
    const second = new FakeConnection({ textDocumentSync: 1 });
    const response = deferred<unknown>();
    second.requestResult = () => response.promise;
    let watcherCount = 0;
    let connectionCount = 0;
    const workspace = new WorkspaceLsp(cwd, {
      resolveServer: async () => server(cwd),
      createConnection: async () => connectionCount++ === 0 ? first : second,
      watcherFactory: () => {
        const watcher = watcherCount++ === 0 ? firstWatcher : secondWatcher;
        queueMicrotask(() => watcher.emit("ready"));
        return watcher;
      },
    });

    try {
      await workspace.query(symbols(file), new AbortController().signal);
      firstWatcher.emit("error", new Error("watch failed"));

      const rebuilt = workspace.query(symbols(file), new AbortController().signal);
      await waitFor(() => second.requests.length === 1);
      firstWatcher.emit("all", "change", file);
      response.resolve([]);

      await expect(rebuilt).resolves.toMatchObject({ value: [] });
    } finally {
      response.resolve([]);
      await workspace.dispose();
    }
  });

  it("adds a retained path once per watcher", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const firstWatcher = new FakeWatcher();
    const secondWatcher = new FakeWatcher();
    const first = new FakeConnection({ textDocumentSync: 1 });
    const second = new FakeConnection({ textDocumentSync: 1 });
    let watcherCount = 0;
    let connectionCount = 0;
    const workspace = new WorkspaceLsp(cwd, {
      resolveServer: async () => server(cwd),
      createConnection: async () => connectionCount++ === 0 ? first : second,
      watcherFactory: () => {
        const watcher = watcherCount++ === 0 ? firstWatcher : secondWatcher;
        queueMicrotask(() => watcher.emit("ready"));
        return watcher;
      },
    });

    try {
      await workspace.query(symbols(file), new AbortController().signal);
      await workspace.query(symbols(file), new AbortController().signal);
      expect(firstWatcher.add).toHaveBeenCalledTimes(1);

      firstWatcher.emit("error", new Error("watch failed"));
      await workspace.query(symbols(file), new AbortController().signal);
      expect(secondWatcher.add).toHaveBeenCalledTimes(1);
    } finally {
      await workspace.dispose();
    }
  });

  it("rejects every borrowed waiter when a failed watcher sync invalidates the old entry", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    const changed = join(cwd, "project.fixture");
    await writeFile(file, "export const value = 1;\n");
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const watchSync = deferred<void>();
    connection.notifyResult = (method) => method === "workspace/didChangeWatchedFiles"
      ? watchSync.promise
      : Promise.resolve();
    const workspace = fakeWorkspace(cwd, connection, { watcher });

    try {
      await workspace.query(symbols(file), new AbortController().signal);
      await writeFile(changed, "changed\n");
      watcher.emit("all", "change", changed);

      const first = workspace.query(symbols(file), new AbortController().signal);
      await waitFor(() => connection.notifications.some(({ method }) => method === "workspace/didChangeWatchedFiles"));
      const second = workspace.query(symbols(file), new AbortController().signal);
      const third = workspace.query(symbols(file), new AbortController().signal);
      await waitFor(() => connection.supports.mock.calls.length === 4);
      watchSync.reject(new LspError("content_modified", "watch synchronization failed"));

      const settled = await Promise.allSettled([first, second, third]);
      for (const result of settled) {
        expect(result).toMatchObject({ status: "rejected", reason: { code: "content_modified" } });
      }
      expect(connection.requests).toHaveLength(1);
    } finally {
      watchSync.resolve();
      await workspace.dispose();
    }
  });

  it("lets an in-flight caller finish when a new fingerprint retires its entry", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const first = new FakeConnection({ textDocumentSync: 1 });
    const second = new FakeConnection({ textDocumentSync: 1 });
    const firstResponse = deferred<unknown>();
    first.requestResult = () => firstResponse.promise;
    let fingerprint = "config-a";
    let connectionCalls = 0;
    const createConnection = vi.fn(async () => {
      connectionCalls += 1;
      return connectionCalls === 1 ? first : second;
    });
    const workspace = fakeWorkspace(cwd, first, {
      createConnection,
      resolveServer: async () => server(cwd, fingerprint),
    });

    try {
      const old = workspace.query(symbols(file), new AbortController().signal);
      await waitFor(() => first.requests.length === 1);
      fingerprint = "config-b";
      await expect(workspace.query(symbols(file), new AbortController().signal)).resolves.toMatchObject({
        server: "typescript",
      });
      firstResponse.resolve(["old"]);
      await expect(old).resolves.toMatchObject({ value: ["old"] });
      expect(createConnection).toHaveBeenCalledTimes(2);
    } finally {
      firstResponse.resolve([]);
      await workspace.dispose();
    }
  });

  it.each([
    ["a ready watcher", "not_enabled", true],
    ["a never-ready watcher", "misconfigured", false],
  ] as const)("rejects %s configuration before allocating a watcher", async (_watcherState, code, emitReady) => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const watcher = new FakeWatcher();
    const watcherFactory = vi.fn(() => {
      if (emitReady) queueMicrotask(() => watcher.emit("ready"));
      return watcher;
    });
    const workspace = new WorkspaceLsp(cwd, {
      resolveServer: async () => {
        throw new LspError(code, "LSP configuration rejected");
      },
      createConnection: async () => new FakeConnection({ textDocumentSync: 1 }),
      watcherFactory,
      timeoutMs: 30,
    });

    try {
      await expect(workspace.query(symbols(file), new AbortController().signal)).rejects.toMatchObject({ code });
      expect(watcherFactory).not.toHaveBeenCalled();
    } finally {
      await workspace.dispose();
    }
  });

  it("uses real chokidar events to notify a server about an unopened external file", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    const extra = join(cwd, "extra.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = new WorkspaceLsp(cwd, {
      resolveServer: async () => server(cwd),
      createConnection: async () => connection,
    });

    await workspace.query(symbols(file), new AbortController().signal);
    await writeFile(extra, "export const extra = 2;\n");
    await waitFor(() => true, 50);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await workspace.query(symbols(file), new AbortController().signal);

    expect(connection.notifications).toContainEqual(expect.objectContaining({
      method: "workspace/didChangeWatchedFiles",
      params: expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({ type: 1 }),
        ]),
      }),
    }));
    await workspace.dispose();
  });

  it("enforces the document mirror size cap without publishing a partial open", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "this file is too large\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = fakeWorkspace(cwd, connection, { maxDocumentBytes: 4 });

    await expect(workspace.query(symbols(file), new AbortController().signal)).rejects.toBeInstanceOf(LspError);
    expect(connection.notifications).not.toContainEqual(expect.objectContaining({
      method: "textDocument/didOpen",
    }));
    await workspace.dispose();
  });

  it("does not share connections across workspace instances or fingerprints", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const first = new FakeConnection({ textDocumentSync: 1 });
    const second = new FakeConnection({ textDocumentSync: 1 });
    const createFirst = vi.fn(async () => first);
    const createSecond = vi.fn(async () => second);
    const one = fakeWorkspace(cwd, first, { createConnection: createFirst });
    const two = fakeWorkspace(cwd, second, {
      createConnection: createSecond,
      resolveServer: async () => server(cwd, "config-b"),
    });

    await Promise.all([
      one.query(symbols(file), new AbortController().signal),
      two.query(symbols(file), new AbortController().signal),
    ]);
    expect(createFirst).toHaveBeenCalledTimes(1);
    expect(createSecond).toHaveBeenCalledTimes(1);
    await Promise.all([one.dispose(), two.dispose()]);
  });

  it("rejects an ABA-late response instead of attaching its old range to restored text", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    const original = "export const value = 1;\n";
    await writeFile(file, original);
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const first = deferred<unknown>();
    let requests = 0;
    connection.requestResult = () => {
      requests += 1;
      return requests === 1 ? first.promise : Promise.resolve([]);
    };
    const workspace = fakeWorkspace(cwd, connection);

    const stale = workspace.query(symbols(file), new AbortController().signal);
    await waitFor(() => connection.requests.length === 1);
    await writeFile(file, "export const value = 2;\n");
    await workspace.query(symbols(file), new AbortController().signal);
    await writeFile(file, original);
    await workspace.query(symbols(file), new AbortController().signal);
    first.resolve(["old-range"]);

    await expect(stale).rejects.toMatchObject({ code: "content_modified" });
    await workspace.dispose();
  });

  it("rejects a response when a watcher change arrives while the target opens", async () => {
    const cwd = await temporaryDirectory();
    const entry = join(cwd, "entry.ts");
    const later = join(cwd, "later.ts");
    await Promise.all([
      writeFile(entry, "export const entry = 1;\n"),
      writeFile(later, "export const later = 1;\n"),
    ]);
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    let changed = false;
    connection.notifyResult = async (method, params) => {
      const uri = (params as { textDocument?: { uri?: string } }).textDocument?.uri;
      if (!changed && method === "textDocument/didOpen" && uri?.endsWith("entry.ts")) {
        changed = true;
        await writeFile(later, "export const later = 2;\n");
        watcher.emit("all", "change", later);
      }
    };
    const workspace = fakeWorkspace(cwd, connection, { watcher });

    await expect(workspace.query(symbols(entry), new AbortController().signal)).rejects.toMatchObject({
      code: "content_modified",
    });
    expect(connection.requests).toHaveLength(1);
    await workspace.dispose();
  });

  it("rejects a workspace response when a watcher observes a later workspace change", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    const added = join(cwd, "later.ts");
    await writeFile(file, "export const value = 1;\n");
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const response = deferred<unknown>();
    connection.requestResult = () => response.promise;
    const workspace = fakeWorkspace(cwd, connection, { watcher });

    const pending = workspace.query({
      operation: "symbols",
      scope: "workspace",
      path: file,
      query: "value",
    }, new AbortController().signal);
    await waitFor(() => connection.requests.length === 1);
    await writeFile(added, "export const later = 1;\n");
    watcher.emit("all", "add", added);
    response.resolve([]);

    await expect(pending).rejects.toMatchObject({ code: "content_modified" });
    await workspace.dispose();
  });

  it("resolves only the bounded URI-only workspace symbols and preserves the server query", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    connection.requestResult = async (method) => {
      if (method === "workspace/symbol") {
        return [
          { name: "one", kind: 12, location: { uri: "file:///one.ts" } },
          { name: "two", kind: 12, location: { uri: "file:///two.ts" } },
        ];
      }
      if (method === "workspaceSymbol/resolve") {
        return {
          name: "one",
          kind: 12,
          location: {
            uri: "file:///one.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        };
      }
      return [];
    };
    const workspace = fakeWorkspace(cwd, connection);

    const result = await workspace.query({
      operation: "symbols",
      scope: "workspace",
      path: file,
      query: "literal query",
      limit: 1,
    }, new AbortController().signal);

    expect(connection.requests[0]).toEqual({
      method: "workspace/symbol",
      params: { query: "literal query" },
    });
    expect(connection.requests.filter(({ method }) => method === "workspaceSymbol/resolve")).toHaveLength(1);
    expect(result.value).toEqual([
      expect.objectContaining({ location: expect.objectContaining({ range: expect.any(Object) }) }),
      { name: "two", kind: 12, location: { uri: "file:///two.ts" } },
    ]);
    await workspace.dispose();
  });

  it("closes admission synchronously and makes dispose idempotent", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = fakeWorkspace(cwd, connection);

    workspace.closeAdmission();
    await expect(workspace.query(symbols(file), new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(Promise.all([workspace.dispose(), workspace.dispose()])).resolves.toEqual([undefined, undefined]);
  });

  it("unblocks a query waiting for watcher readiness when the workspace is disposed", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const watcher = new FakeWatcher();
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = new WorkspaceLsp(cwd, {
      resolveServer: async () => server(cwd),
      createConnection: async () => connection,
      watcherFactory: () => watcher,
    });

    const pending = workspace.query(symbols(file), new AbortController().signal);
    await waitFor(() => watcher.add.mock.calls.length === 1);
    await workspace.dispose();

    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reclaims an owner-idle connection despite an abandoned wire pending count", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    await writeFile(file, "export const value = 1;\n");
    const first = new FakeConnection({ textDocumentSync: 1 });
    first.pendingCount = 1;
    const second = new FakeConnection({ textDocumentSync: 1 });
    let factoryCalls = 0;
    const createConnection = vi.fn(async () => {
      factoryCalls += 1;
      return factoryCalls === 1 ? first : second;
    });
    const workspace = fakeWorkspace(cwd, first, { createConnection, idleMs: 1 });

    await workspace.query(symbols(file), new AbortController().signal);
    await waitFor(() => first.dispose.mock.calls.length === 1);
    await workspace.query(symbols(file), new AbortController().signal);

    expect(createConnection).toHaveBeenCalledTimes(2);
    await workspace.dispose();
  });

  it("closes an open mirror before a filesystem rename removes its source", async () => {
    const cwd = await temporaryDirectory();
    const file = join(cwd, "entry.ts");
    const replacement = join(cwd, "replacement.ts");
    await writeFile(file, "export const value = 1;\n");
    const connection = new FakeConnection({ textDocumentSync: 1 });
    const workspace = fakeWorkspace(cwd, connection);

    await workspace.query(symbols(file), new AbortController().signal);
    await rename(file, replacement);
    await expect(workspace.query(symbols(replacement), new AbortController().signal)).resolves.toMatchObject({
      uri: expect.stringContaining("replacement.ts"),
    });
    expect(connection.notifications).toContainEqual(expect.objectContaining({
      method: "textDocument/didClose",
    }));
    await workspace.dispose();
  });
});
