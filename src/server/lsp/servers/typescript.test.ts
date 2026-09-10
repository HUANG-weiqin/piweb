import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLspServer } from "../definition.js";
import { typescript } from "./typescript.js";

const temporaryDirectories: string[] = [];
const command = [process.execPath, "server.js"];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "piweb-typescript-profile-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function configure(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({ version: 1, servers: [{ id: "typescript", command }] }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("TypeScript language-server profile", () => {
  it("declares the standard TLS command, language modes, root-marker priority, and no invented watcher coverage", () => {
    expect(typescript).toMatchObject({
      id: "typescript",
      adapterVersion: 1,
      command: ["typescript-language-server", "--stdio"],
      extensionToLanguage: {
        ".ts": "typescript",
        ".tsx": "typescriptreact",
        ".mts": "typescript",
        ".cts": "typescript",
        ".js": "javascript",
        ".jsx": "javascriptreact",
        ".mjs": "javascript",
        ".cjs": "javascript",
      },
      rootMarkers: [["tsconfig.json", "jsconfig.json"], ["package.json"]],
      initializationOptions: {},
      settings: {},
      watchFiles: [],
    });
    expect(typescript.adaptConnection).toBeUndefined();
  });

  it("uses the closest TypeScript config, falls back to package.json, and preserves marker ambiguity with an explicit-root escape", async () => {
    const directory = await temporaryDirectory();
    const config = join(directory, "lsp.json");
    const configured = join(directory, "configured");
    const configuredNested = join(configured, "nested");
    const fallback = join(directory, "fallback");
    const fallbackNested = join(fallback, "nested");
    const ambiguous = join(directory, "ambiguous");
    const ambiguousNested = join(ambiguous, "nested");
    await Promise.all([
      mkdir(configuredNested, { recursive: true }),
      mkdir(fallbackNested, { recursive: true }),
      mkdir(ambiguousNested, { recursive: true }),
    ]);
    const configuredFile = join(configuredNested, "index.ts");
    const fallbackFile = join(fallbackNested, "index.js");
    const ambiguousFile = join(ambiguousNested, "index.ts");
    await Promise.all([
      writeFile(join(configured, "package.json"), "{}"),
      writeFile(join(configured, "tsconfig.json"), "{}"),
      writeFile(join(configuredNested, "jsconfig.json"), "{}"),
      writeFile(configuredFile, "export const configured = true;\n"),
      writeFile(join(fallback, "package.json"), "{}"),
      writeFile(fallbackFile, "export const fallback = true;\n"),
      writeFile(join(ambiguous, "tsconfig.json"), "{}"),
      writeFile(join(ambiguous, "jsconfig.json"), "{}"),
      writeFile(ambiguousFile, "export const ambiguous = true;\n"),
    ]);
    await configure(config);

    const configuredResult = await resolveLspServer(configured, configuredFile, config);
    expect(configuredResult.root).toBe(configuredNested);
    expect(configuredResult.extensionToLanguage[".ts"]).toBe("typescript");
    expect(configuredResult.adaptConnection).toBeUndefined();

    const fallbackResult = await resolveLspServer(fallback, fallbackFile, config);
    expect(fallbackResult.root).toBe(fallback);
    expect(fallbackResult.extensionToLanguage[".js"]).toBe("javascript");

    await expect(resolveLspServer(ambiguous, ambiguousFile, config)).rejects.toMatchObject({
      code: "ambiguous_server",
    });
    await writeFile(config, JSON.stringify({
      version: 1,
      servers: [{ id: "typescript", command, root: "nested" }],
    }));
    expect((await resolveLspServer(ambiguous, ambiguousFile, config)).root).toBe(ambiguousNested);
  });
});
