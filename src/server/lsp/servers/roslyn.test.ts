import { describe, expect, it, vi } from "vitest";
import { LspError, type LspConnection, type LspNotificationMethod, type LspRequestMethod } from "../contracts.js";
import { roslyn } from "./roslyn.js";

function fixture() {
  const state = { alive: true, pending: 0, references: true };
  const request = vi.fn(async (_method: LspRequestMethod, _params: unknown, _signal?: AbortSignal): Promise<unknown> => []);
  const notify = vi.fn(async (_method: LspNotificationMethod, _params: unknown) => undefined);
  const dispose = vi.fn(async () => { state.alive = false; });
  const acceptsFileChanges = vi.fn((_path: string, _type: 1 | 2 | 3) => true);
  const inner: LspConnection = {
    capabilities: { definitionProvider: true, referencesProvider: true },
    get alive() { return state.alive; },
    get pendingCount() { return state.pending; },
    supports: (method) => method !== "textDocument/references" || state.references,
    acceptsFileChanges,
    request,
    notify,
    dispose,
  };
  return { state, inner, request, notify, dispose, acceptsFileChanges, connection: roslyn.adaptConnection?.(inner) ?? inner };
}

const params = { textDocument: { uri: "file:///project/Program.cs" }, position: { line: 4, character: 10 } };

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("Roslyn semantic preparation", () => {
  it("prepares full semantics before definition without serializing other requests", async () => {
    const { connection, request } = fixture();
    const preparation = deferred();
    request.mockImplementation(async (method) => method === "textDocument/references" ? preparation.promise : [method]);
    const signal = new AbortController().signal;
    const result = connection.request("textDocument/definition", params, signal);
    expect(request).toHaveBeenCalledExactlyOnceWith("textDocument/references", {
      ...params, context: { includeDeclaration: true },
    }, signal);

    await expect(connection.request("workspace/symbol", { query: "other" })).resolves.toEqual(["workspace/symbol"]);
    preparation.resolve([]);
    await expect(result).resolves.toEqual(["textDocument/definition"]);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "textDocument/references", "workspace/symbol", "textDocument/definition",
    ]);
    expect(request).toHaveBeenLastCalledWith("textDocument/definition", params, signal);
  });

  it.each(["cancelled", "timeout", "unavailable"] as const)("does not dispatch definition or retry after preparation %s", async (code) => {
    const { connection, request, dispose } = fixture();
    const failure = new LspError(code, "preparation failed");
    request.mockRejectedValue(failure);
    await expect(connection.request("textDocument/definition", params)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("textDocument/references");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not send the second request if the caller cancels during preparation", async () => {
    const { connection, request, dispose } = fixture();
    const preparation = deferred();
    request.mockReturnValue(preparation.promise);
    const controller = new AbortController();
    const result = connection.request("textDocument/definition", params, controller.signal);
    controller.abort();
    preparation.resolve([]);
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("rejects a preparation invalidated by another caller's document synchronization", async () => {
    const { connection, request, dispose } = fixture();
    const preparation = deferred();
    request.mockReturnValue(preparation.promise);
    const result = connection.request("textDocument/definition", params);
    await connection.notify("textDocument/didChange", {
      textDocument: { uri: "file:///project/Helper.cs", version: 2 },
      contentChanges: [{ text: "class Helper {}" }],
    });
    preparation.resolve([]);
    await expect(result).rejects.toMatchObject({ code: "content_modified" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("leaves references and symbols as single requests", async () => {
    const { connection, request } = fixture();
    for (const method of ["textDocument/references", "textDocument/documentSymbol", "workspace/symbol"] as const) {
      await connection.request(method, params);
    }
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "textDocument/references", "textDocument/documentSymbol", "workspace/symbol",
    ]);
  });

  it("preserves live ownership and requires reference capability for definitions", async () => {
    const { connection, inner, state, acceptsFileChanges, notify, dispose } = fixture();
    expect(connection.capabilities).toBe(inner.capabilities);
    expect(connection.supports("textDocument/definition")).toBe(true);
    state.references = false;
    expect(connection.supports("textDocument/definition")).toBe(false);
    state.pending = 3;
    expect(connection.pendingCount).toBe(3);
    expect(connection.acceptsFileChanges("source.cs", 3)).toBe(true);
    expect(acceptsFileChanges).toHaveBeenCalledWith("source.cs", 3);
    await connection.notify("textDocument/didClose", params);
    expect(notify).toHaveBeenCalledWith("textDocument/didClose", params);
    await connection.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(connection.alive).toBe(false);
  });
});
