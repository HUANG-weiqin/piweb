import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LSP_MAX_RESULT_BYTES, LspError, type LspQueryResponse } from "./contracts.js";
import { createLspTools } from "./tools.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const nativeFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let cwd: string;
let file: string;
let uri: string;
const range = { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } };
beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(nativeFs.open);
  cwd = await realpath(await mkdtemp(join(tmpdir(), "piweb-lsp-tools-")));
  file = join(cwd, "source.cs");
  uri = pathToFileURL(file).href;
  await writeFile(file, "😀class Example {}\r\n");
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

function tools(value: unknown) {
  const query = vi.fn(async (): Promise<LspQueryResponse> => ({ server: "test", root: cwd, uri, value }));
  return { query, tools: createLspTools(cwd, { query }) };
}
async function invoke(tool: ReturnType<typeof createLspTools>[number], input: unknown, signal = new AbortController().signal) {
  return tool.execute("call", input as never, signal, undefined, {} as never);
}

describe("bounded, read-only LSP SDK tools", () => {
  it("exports exactly three closed schemas and forwards one-based UTF16 positions", async () => {
    const fixture = tools([{ uri, range }]);
    expect(fixture.tools.map((tool) => tool.name)).toEqual(["lsp_symbols", "lsp_definition", "lsp_references"]);
    for (const tool of fixture.tools) {
      expect(JSON.stringify(tool.parameters)).not.toMatch(/anyOf|oneOf/);
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    const input = { path: "source.cs", line: 1, column: 3 };
    const result = await invoke(fixture.tools[1]!, input);
    expect(fixture.query).toHaveBeenCalledWith({ ...input, operation: "definition" }, expect.any(AbortSignal));
    expect(result.details).toMatchObject({ status: "ok", positionEncoding: "utf-16", items: [{ path: "source.cs", range: { start: { line: 1, column: 3 } }, disk: { line: 1, text: "😀class Example {}", observation: "read_after_response" } }] });
  });

  it("flattens document symbols without permanent IDs and retains unresolved URI-only workspace symbols", async () => {
    const fixture = tools([{ name: "Example", kind: 5, range, selectionRange: range, children: [{ name: "member", kind: 6, range, selectionRange: range }] }]);
    const result = await invoke(fixture.tools[0]!, { path: "source.cs", scope: "document" });
    expect(result.details).toMatchObject({ items: [{ name: "Example" }, { name: "member", containerName: "Example" }] });
    const unresolved = tools([{ name: "Opaque", kind: 5, location: { uri: "roslyn-source-generated://virtual/Example.cs" } }]);
    const output = await invoke(unresolved.tools[0]!, { path: "source.cs", scope: "workspace", query: "Opaque" });
    expect(output.details).toMatchObject({ items: [{ name: "Opaque", readStatus: "non_file_uri" }] });
    expect(JSON.stringify(output.details)).not.toContain('"range"');
    expect(JSON.stringify(output.details)).not.toContain("symbolId");
  });

  it("does not treat malformed workspace ranges as unresolved URI-only symbols", async () => {
    for (const malformed of [null, {}, { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } }]) {
      const fixture = tools([{ name: "Broken", kind: 5, location: { uri, range: malformed } }]);
      await expect(invoke(fixture.tools[0]!, { path: file, scope: "workspace" })).rejects.toThrow("Invalid LSP location");
    }
  });

  it("preserves the UTF-8 BOM in independent disk snippets", async () => {
    await writeFile(file, "\uFEFFclass Example {}\r\n");
    const fixture = tools([{ uri, range }]);
    const output = await invoke(fixture.tools[1]!, { path: file, line: 1, column: 3 });
    expect(output.details).toMatchObject({ items: [{ disk: { text: "\uFEFFclass Example {}" } }] });
  });

  it("uses LocationLink's target selection, never reads external files or virtual URIs", async () => {
    const fixture = tools([
      { targetUri: uri, targetRange: range, targetSelectionRange: range },
      { uri: pathToFileURL(join(tmpdir(), "outside.cs")).href, range },
      { uri: "metadata://assembly/Type", range },
      { uri: "file://remote-host/share/file.cs", range },
    ]);
    const output = await invoke(fixture.tools[1]!, { path: file, line: 1, column: 3 });
    expect(output.details).toMatchObject({ items: [
      { path: "source.cs", disk: { line: 1 } },
      { readStatus: "outside_workspace" },
      { readStatus: "non_file_uri" },
      { readStatus: "non_local_uri" },
    ] });
  });

  it("does not read a target replaced by an external directory junction after path checks", async () => {
    const directory = join(cwd, "nested");
    await mkdir(directory);
    const target = join(directory, "target.cs");
    await writeFile(target, "class Internal {}\n");
    const outside = await mkdtemp(join(tmpdir(), "piweb-lsp-outside-"));
    await writeFile(join(outside, "target.cs"), "class ExternalSecret {}\n");
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
      const fixture = tools([{ uri: pathToFileURL(target).href, range }]);
      const output = await invoke(fixture.tools[1]!, { path: file, line: 1, column: 3 });
      expect(JSON.stringify(output.details)).not.toContain("ExternalSecret");
      expect(output.details).toMatchObject({ items: [{ readStatus: "unavailable" }] });
      expect(externalRead).toBeDefined();
      expect(externalRead).not.toHaveBeenCalled();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps the owner's canonical workspace when a query replaces the entire cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "piweb-lsp-rebased-"));
    const external = join(outside, "external.cs");
    await writeFile(external, "class ExternalSecret {}\n");
    const fixture = tools(null);
    fixture.query.mockImplementationOnce(async () => {
      await rename(cwd, join(outside, "original"));
      await symlink(outside, cwd, process.platform === "win32" ? "junction" : "dir");
      return { server: "test", root: cwd, uri, value: [{ uri: pathToFileURL(external).href, range }] };
    });
    try {
      const output = await invoke(fixture.tools[1]!, { path: file, line: 1, column: 3 });
      expect(JSON.stringify(output.details)).not.toContain("ExternalSecret");
      expect(output.details).toMatchObject({ items: [{ readStatus: "outside_workspace" }] });
      expect(open).not.toHaveBeenCalled();
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("distinguishes successful emptiness from unsupported and other failures", async () => {
    const fixture = tools(null);
    const output = await invoke(fixture.tools[1]!, { path: file, line: 1, column: 3 });
    expect(output.details).toMatchObject({ status: "ok", items: [], truncated: false });
    for (const code of ["unsupported", "timeout", "unavailable", "cancelled", "content_modified", "resource_limit"] as const) {
      fixture.query.mockRejectedValueOnce(new LspError(code, "explanation"));
      await expect(invoke(fixture.tools[1]!, { path: file, line: 1, column: 3 })).rejects.toThrow(`[${code}]`);
    }
    await expect(invoke(tools({ unexpected: true }).tools[1]!, { path: file, line: 1, column: 3 })).rejects.toThrow("Invalid LSP location");
  });

  it("enforces item and serialized UTF8 budgets, including JSON escapes and deeply nested symbols", async () => {
    const fixture = tools(Array.from({ length: 150 }, (_, index) => ({ name: `item${index}` + "\0".repeat(2000), kind: 5, location: { uri, range } })));
    const output = await invoke(fixture.tools[0]!, { path: file, scope: "workspace", limit: 100 });
    expect(Buffer.byteLength(output.content[0]!.type === "text" ? output.content[0]!.text : "")).toBeLessThanOrEqual(LSP_MAX_RESULT_BYTES);
    expect(output.details).toMatchObject({ truncated: true });
    const limited = await invoke(fixture.tools[0]!, { path: file, scope: "workspace", limit: 1 });
    expect((limited.details as { items: unknown[] }).items).toHaveLength(1);
    expect(limited.details).toMatchObject({ truncated: true });
  });

  it("validates inputs and cancellation before invoking the service", async () => {
    const fixture = tools([]);
    for (const input of [
      { path: file, line: 0, column: 1 },
      { path: file, line: 1, column: 1, command: "bad" },
      { path: file, line: 1, column: 1, limit: 101 },
    ]) {
      await expect(invoke(fixture.tools[1]!, input)).rejects.toThrow("Invalid lsp_definition input");
    }
    await expect(invoke(fixture.tools[1]!, { path: file, line: 1, column: 1 }, AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(fixture.query).not.toHaveBeenCalled();
  });
});
