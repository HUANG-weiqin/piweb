import { afterEach, describe, expect, it } from "vitest";
import { basename, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspConnection, ResolvedLspServer } from "./contracts.js";
import { createLspConnection } from "./connection.js";

const fixture = fileURLToPath(new URL("./test-server.mjs", import.meta.url));
const connections: LspConnection[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function open(
  scenario: string,
  options: Record<string, number> = {},
  adaptConnection?: ResolvedLspServer["adaptConnection"],
): Promise<{ connection: LspConnection; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "piweb-lsp-"));
  roots.push(root);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PIWEB_LSP_FIXTURE_RECORD = join(root, "fixture-record.json");
  const server: ResolvedLspServer = {
    id: "fixture",
    root,
    command: [process.execPath, fixture, scenario],
    env,
    extensionToLanguage: { ".fixture": "fixture" },
    initializationOptions: {},
    settings: { probe: { enabled: true }, plain: "plain-value" },
    watchFiles: ["**/*.static"],
    fingerprint: "fixture",
    adaptConnection,
  };
  const connection = await createLspConnection(server, {
    initializeTimeoutMs: 500,
    requestTimeoutMs: 500,
    disposeGraceMs: 80,
    ...options,
  });
  connections.push(connection);
  return { connection, root };
}

async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

describe("createLspConnection", () => {
  it("accepts fragmented and concatenated stdio LSP frames", async () => {
    const { connection } = await open("fragmented");

    await expect(connection.request("workspace/symbol", { query: "frame" }))
      .resolves.toEqual({ query: "frame" });
    expect(connection.capabilities.workspaceSymbolProvider).toBeDefined();
  });

  it("binds a trusted adapter only after initialization and cleans up if binding fails", async () => {
    let adapted: LspConnection | undefined;
    const { connection } = await open("fragmented", {}, (owner) => {
      expect(owner.alive).toBe(true);
      adapted = owner;
      return owner;
    });
    expect(connection).toBe(adapted);

    let failedOwner: LspConnection | undefined;
    const failure = new Error("adapter failed");
    await expect(open("fragmented", {}, (owner) => {
      failedOwner = owner;
      throw failure;
    })).rejects.toMatchObject({ code: "misconfigured", cause: failure });
    expect(failedOwner).toBeDefined();
    expect(failedOwner?.alive).toBe(false);
    expect(failedOwner?.pendingCount).toBe(0);
  });

  it("rejects malformed and oversized stdout frames before JSON-RPC parsing", async () => {
    await expect(open("bad-header", { maxHeaderBytes: 32 })).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(open("oversize", { maxFrameBytes: 64 })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("fails initialization for unsupported encoding, exit, and deadline", async () => {
    await expect(open("utf8")).rejects.toMatchObject({ code: "misconfigured" });
    await expect(open("exit-before-init")).rejects.toMatchObject({ code: "unavailable" });
    await expect(open("hang-init", { initializeTimeoutMs: 30 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("announces UTF-16 capabilities, settings, folders, and reusable string progress", async () => {
    const { connection, root } = await open("reverse");
    let state: {
      reverse?: {
        config: unknown[];
        folders: unknown;
        progressCreated: unknown;
        progressReused: unknown;
      };
      configurationNotification?: { settings?: unknown };
      initialize?: { capabilities?: Record<string, unknown> };
    } | undefined;
    await eventually(async () => {
      state = await connection.request("workspace/symbol", { query: "reverse-state" }) as typeof state;
      return state?.configurationNotification !== undefined && state?.reverse?.progressReused !== undefined;
    });

    expect(state?.reverse?.config).toEqual([true, null, "plain-value"]);
    expect(state?.reverse?.folders).toEqual([{ uri: pathToFileURL(root).href, name: basename(root) }]);
    expect(state?.reverse?.progressCreated).toBeNull();
    expect(state?.reverse?.progressReused).toBeNull();
    expect(state?.configurationNotification).toEqual({ settings: { probe: { enabled: true }, plain: "plain-value" } });
    expect(state?.initialize?.capabilities).toMatchObject({
      workspace: { applyEdit: false, symbol: { resolveSupport: { properties: ["location.range"] } } },
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        definition: { linkSupport: true },
      },
    });
    expect(connection.acceptsFileChanges(join(root, "nested", "file.static"), 2)).toBe(true);
    expect(connection.acceptsFileChanges(join(root, "nested", "file.txt"), 2)).toBe(false);
  });

  it("tracks dynamically registered query and file-watch capabilities", async () => {
    const { connection, root } = await open("dynamic-query");
    const uri = pathToFileURL(join(root, "file.fixture")).href;

    await eventually(() => connection.supports("workspace/symbol"));
    expect(connection.supports("workspaceSymbol/resolve")).toBe(true);
    expect(connection.supports("textDocument/documentSymbol", { uri, languageId: "fixture" })).toBe(true);
    expect(connection.supports("textDocument/documentSymbol", { uri, languageId: "other" })).toBe(false);
    await expect(connection.request("textDocument/documentSymbol", { textDocument: { uri } })).resolves.toBeNull();

    await connection.request("workspace/symbol", { query: "unregister" });
    await eventually(() => !connection.supports("workspace/symbol"));
    expect(connection.supports("workspaceSymbol/resolve")).toBe(false);

    const watched = await open("register-watch");
    await eventually(() => watched.connection.acceptsFileChanges(join(watched.root, "a.dynamic"), 2));
    expect(watched.connection.acceptsFileChanges(join(watched.root, "config", "settings.json"), 2)).toBe(true);
    expect(watched.connection.acceptsFileChanges(join(watched.root, "other", "settings.json"), 2)).toBe(false);
    expect(watched.connection.acceptsFileChanges(join(watched.root, "file.created"), 1)).toBe(true);
    expect(watched.connection.acceptsFileChanges(join(watched.root, "file.created"), 2)).toBe(false);
    expect(watched.connection.acceptsFileChanges(join(watched.root, "file.created"), 3)).toBe(false);
    expect(watched.connection.acceptsFileChanges(join(watched.root, "file.mixed"), 1)).toBe(true);
    expect(watched.connection.acceptsFileChanges(join(watched.root, "file.mixed"), 2)).toBe(false);
    expect(watched.connection.acceptsFileChanges(join(watched.root, "file.mixed"), 3)).toBe(true);
    expect(watched.connection.acceptsFileChanges(join(watched.root, "file.invalid"), 1)).toBe(false);
    await eventually(async () => {
      const state = await watched.connection.request("workspace/symbol", { query: "state" }) as {
        registrations?: Array<{ error?: { code?: number } }>;
      };
      return state.registrations?.length === 2;
    });
    const state = await watched.connection.request("workspace/symbol", { query: "state" }) as {
      registrations?: Array<{ error?: { code?: number } }>;
    };
    expect(state.registrations?.[1]?.error?.code).toBe(-32602);
  });

  it("rejects oversized reverse batches atomically without consuming a later legal registration", async () => {
    const { connection } = await open("registration-cap");
    let state: {
      capacity?: {
        acceptedConfiguration: { result?: unknown[] };
        configuration: { error?: { code?: number } };
        overflow: { error?: { code?: number } };
        unregistration: { error?: { code?: number; message?: string } };
        legal: { result?: unknown };
      };
    } | undefined;
    await eventually(async () => {
      if (!connection.supports("workspace/symbol")) return false;
      state = await connection.request("workspace/symbol", { query: "state" }) as typeof state;
      return state?.capacity !== undefined;
    });
    expect(state?.capacity?.acceptedConfiguration.result).toEqual([
      true,
      "plain-value",
      ...Array.from({ length: 73 }, () => null),
    ]);
    expect(state?.capacity?.configuration.error?.code).toBe(-32602);
    expect(state?.capacity?.overflow.error?.code).toBe(-32602);
    expect(state?.capacity?.unregistration.error).toMatchObject({
      code: -32602,
      message: "Too many LSP capability unregisterations",
    });
    expect(state?.capacity?.legal.result ?? null).toBeNull();
  });

  it("sends shutdown without a null params field", async () => {
    const { connection, root } = await open("shutdown-wire");

    await connection.dispose();
    await expect(readFile(join(root, "fixture-record.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ hasParams: false }));
  });

  it("rejects unsupported requests instead of returning an empty result", async () => {
    const { connection } = await open("none");

    expect(connection.supports("workspace/symbol")).toBe(false);
    await expect(connection.request("workspace/symbol", { query: "nope" })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("cancels one caller without killing another request and retains ignored cancellation wire state", async () => {
    const { connection } = await open("normal", { maxPendingRequests: 2 });
    const controller = new AbortController();
    const cancelled = connection.request("workspace/symbol", { query: "slow" }, controller.signal);

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    expect(connection.pendingCount).toBe(1);
    await expect(connection.request("workspace/symbol", { query: "fast" }))
      .resolves.toEqual({ query: "fast" });
    expect(connection.alive).toBe(true);
    await eventually(() => connection.pendingCount === 0);
  });

  it("counts abandoned wire requests against the cap until their late response arrives", async () => {
    const { connection } = await open("normal", { maxPendingRequests: 1 });
    const controller = new AbortController();
    const abandoned = connection.request("workspace/symbol", { query: "slow" }, controller.signal);

    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ code: "cancelled" });
    await expect(connection.request("workspace/symbol", { query: "fast" })).rejects.toMatchObject({
      code: "resource_limit",
    });
    await eventually(() => connection.pendingCount === 0);
    await expect(connection.request("workspace/symbol", { query: "fast" }))
      .resolves.toEqual({ query: "fast" });
  });

  it("maps standard server request errors and fails closed for server-to-client edits and unknown requests", async () => {
    const normal = await open("normal");
    await expect(normal.connection.request("workspace/symbol", { query: "notfound" }))
      .rejects.toMatchObject({ code: "unsupported" });
    await expect(normal.connection.request("workspace/symbol", { query: "content-modified" }))
      .rejects.toMatchObject({ code: "content_modified" });

    const closed = await open("failclosed");
    let state: {
      reverse?: {
        applyEdit: { result?: unknown };
        unknown: { error?: { code?: number } };
      };
    } | undefined;
    await eventually(async () => {
      state = await closed.connection.request("workspace/symbol", { query: "state" }) as typeof state;
      return state?.reverse !== undefined;
    });
    expect(state?.reverse?.applyEdit.result).toMatchObject({ applied: false });
    expect(state?.reverse?.unknown.error?.code).toBe(-32601);
  });

  it("marks a live connection unavailable after an unexpected child exit", async () => {
    const { connection } = await open("exit-after-init");
    await eventually(() => !connection.alive);
    await expect(connection.request("workspace/symbol", { query: "after-exit" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("shuts down the owned Windows process tree when the server ignores shutdown", async () => {
    const { connection } = await open("child-tree", { disposeGraceMs: 40 });
    const child = await connection.request("workspace/symbol", { query: "child-pid" }) as { pid: number };

    await connection.dispose();
    await eventually(() => !isAlive(child.pid), 2_000);
    expect(connection.alive).toBe(false);
  });

  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("forces the owned POSIX process group after shutdown is ignored", async () => {
    const { connection } = await open("child-tree", { disposeGraceMs: 40 });
    const child = await connection.request("workspace/symbol", { query: "child-pid" }) as { pid: number };

    await connection.dispose();
    await eventually(() => !isAlive(child.pid), 2_000);
    expect(connection.alive).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
