import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveLspServer } from "./definition.js";

let dir: string;
let cwd: string;
let file: string;
let config: string;
const command = [process.execPath, "server.js"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "piweb-lsp-config-"));
  cwd = join(dir, "project");
  await mkdir(join(cwd, "nested"), { recursive: true });
  file = join(cwd, "nested", "Example.cs");
  config = join(dir, "lsp.json");
  await writeFile(file, "class Example {}\n");
  await writeFile(join(cwd, "Example.sln"), "");
  await writeFile(join(cwd, "README.md"), "unrelated");
  await writeFile(join(cwd, "Z.txt"), "unrelated");
  await writeFile(join(cwd, "nested", "Example.csproj"), "");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function configure(servers: unknown[]) {
  await writeFile(config, JSON.stringify({ version: 1, servers }));
}

describe("LSP user-owned declarations", () => {
  it("is opt-in even when a known source and project marker exist", async () => {
    await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "not_enabled" });
  });

  it("prefers the solution root over a nearer project root and deeply freezes resolved configuration", async () => {
    await configure([{ id: "roslyn", command, settings: { editor: { mode: "a" } } }]);
    const result = await resolveLspServer(cwd, file, config);
    expect(result.root).toBe(cwd);
    expect(result.extensionToLanguage[".cs"]).toBe("csharp");
    expect(result.command).toEqual(command);
    expect(Object.isFrozen(result.settings.editor)).toBe(true);
    expect(Object.isFrozen(result.env)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.adaptConnection).toBeTypeOf("function");
  });

  it("fingerprints every effective setting deterministically, including environment and arguments", async () => {
    await configure([{ id: "roslyn", command, env: { EXAMPLE: "one" }, settings: { a: 1, b: 2 } }]);
    const first = await resolveLspServer(cwd, file, config);
    await configure([{ settings: { b: 2, a: 1 }, env: { EXAMPLE: "one" }, command, id: "roslyn" }]);
    expect((await resolveLspServer(cwd, file, config)).fingerprint).toBe(first.fingerprint);
    for (const change of [
      { env: { EXAMPLE: "two" } },
      { command: [...command, "--changed"] },
      { initializationOptions: { option: true } },
      { settings: { a: 2 } },
      { watchFiles: ["**/*.cs"] },
      { extensionToLanguage: { ".cs": "other" } },
    ]) {
      await configure([{ id: "roslyn", command, env: { EXAMPLE: "one" }, settings: { a: 1, b: 2 }, ...change }]);
      expect((await resolveLspServer(cwd, file, config)).fingerprint).not.toBe(first.fingerprint);
    }
  });

  it("does not choose an ambiguous server or marker by registration order", async () => {
    await configure([
      { id: "roslyn", command },
      { id: "custom", command, extensionToLanguage: { ".cs": "custom" }, rootMarkers: [["*.sln"]] },
    ]);
    await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "ambiguous_server" });
    await configure([{ id: "roslyn", command }]);
    await writeFile(join(cwd, "Other.sln"), "");
    await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "ambiguous_server" });
    // Explicitly selecting an independent project directory is unambiguous.
    await configure([{ id: "roslyn", command, root: "nested" }]);
    expect((await resolveLspServer(cwd, file, config)).root).toBe(join(cwd, "nested"));
  });

  it("uses an exact workspace entry instead of the same ID's global entry", async () => {
    await configure([
      { id: "roslyn", command, settings: { selected: "global" } },
      { id: "roslyn", command, workspace: cwd, settings: { selected: "local" } },
      { id: "roslyn", command, workspace: join(dir, "not-current"), settings: { selected: "other" } },
    ]);
    expect((await resolveLspServer(cwd, file, config)).settings).toEqual({ selected: "local" });
    await configure([{ id: "roslyn", command }, { id: "roslyn", command }]);
    await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "misconfigured" });
  });

  it("rejects roots outside the workspace and outside the target's ancestry", async () => {
    await configure([{ id: "roslyn", command, root: dir }]);
    await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "invalid_path" });
    await mkdir(join(cwd, "other"));
    await configure([{ id: "roslyn", command, root: "other" }]);
    await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("supports a new language as data, without a built-in or a runtime branch", async () => {
    const customFile = join(cwd, "example.xyz");
    await writeFile(customFile, "example");
    await configure([{ id: "example", command, extensionToLanguage: { ".xyz": "example" }, rootMarkers: [["*.sln"]] }]);
    const result = await resolveLspServer(cwd, customFile, config);
    expect(result.id).toBe("example");
    expect(result.adaptConnection).toBeUndefined();
  });

  it("fails closed for invalid, oversized, incomplete and shell-dependent configurations", async () => {
    for (const servers of [
      [{ id: "custom", command }],
      [{ id: "roslyn", command, unexpected: true }],
      [{ id: "roslyn", command, adaptConnection: "user-supplied-code" }],
      [{ id: "roslyn", command: ["server.cmd"] }],
      [{ id: "roslyn", command: ["./server"] }],
      [{ id: "roslyn", command, rootMarkers: [["../*.sln"]] }],
    ]) {
      await configure(servers);
      await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "misconfigured" });
    }
    await writeFile(config, JSON.stringify({ version: 1, servers: [{ id: "roslyn", settings: { a: "x".repeat(65536) } }] }));
    await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "resource_limit" });
    await writeFile(config, '{"version":1,"servers":[{"id":"roslyn","settings":{"x":1e999}}]}');
    await expect(resolveLspServer(cwd, file, config)).rejects.toMatchObject({ code: "misconfigured" });
  });
});
