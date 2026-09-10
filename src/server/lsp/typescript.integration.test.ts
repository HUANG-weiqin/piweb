import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import chokidar from "chokidar";
import { afterEach, describe, expect, it } from "vitest";
import type { LspConnection, LspConnectionFactory, LspNotificationMethod, LspRequestMethod } from "./contracts.js";
import { createLspConnection } from "./connection.js";
import { resolveLspServer } from "./definition.js";
import { WorkspaceLsp } from "./workspace.js";

/**
 * This suite is opt-in because TLS and its TypeScript runtime are user-owned.
 * It must never install, download, or modify either prerequisite.
 */
const commandJson = process.env.PIWEB_LSP_TYPESCRIPT_COMMAND;
const optedIn = commandJson !== undefined;
const INITIAL_TIMEOUT_MS = 30_000;
const WATCH_TIMEOUT_MS = 15_000;

const packageFile = JSON.stringify({ private: true, type: "commonjs" }, null, 2);
const initialConfig = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "commonjs", moduleResolution: "node", strict: true },
  include: ["src/**/*.ts"],
}, null, 2);
const configuredConfig = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "commonjs", moduleResolution: "node", strict: true },
  include: ["src/**/*.ts", "feature/**/*.ts"],
}, null, 2);
const programText = `import * as helpers from "./helper";

export const value = "😀".length + helpers.helper(1);
`;
const helperText = `export function helper(value: number): number {
  return value + 1;
}
`;
const changedHelperText = `export const insertedOne = 1;
export const insertedTwo = 2;
export function helper(value: number): number {
  return value + 2;
}
`;

type Location = {
  readonly uri: string;
  readonly range: { readonly start: { readonly line: number; readonly character: number } };
};

type DidOpen = { readonly uri: string; readonly text: string; readonly version: number };
type FileChangeAcceptance = { readonly path: string; readonly type: 1 | 2 | 3; readonly accepted: boolean };
type WatchObservation = { readonly event: string; readonly path: string };
type ConnectionObservation = {
  factoryCount: number;
  readonly didOpens: DidOpen[];
  readonly fileChangeAcceptances: FileChangeAcceptance[];
};

let temporaryRoot: string | undefined;
const workspaces: WorkspaceLsp[] = [];

function parseCommand(): [string, ...string[]] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commandJson ?? "");
  } catch (error) {
    throw new Error("PIWEB_LSP_TYPESCRIPT_COMMAND must be a JSON argv array", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error("PIWEB_LSP_TYPESCRIPT_COMMAND must be a non-empty node plus TLS argv array");
  }
  const command = parsed as [string, ...string[]];
  if (process.platform === "win32" && (
    !isAbsolute(command[0]) || basename(command[0]).toLowerCase() !== "node.exe" ||
    !isAbsolute(command[1]!) || !command[1]!.replace(/\\/gu, "/").endsWith("/typescript-language-server/lib/cli.mjs") ||
    command.slice(2).join("\0") !== "--stdio"
  )) {
    throw new Error("Windows TypeScript TLS requires node.exe plus an absolute cli.mjs path and --stdio");
  }
  return command;
}

function tsserverPath(command: readonly string[]): string {
  return join(dirname(dirname(dirname(command[1]!))), "typescript", "lib", "tsserver.js");
}

function normalize(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function sameUri(left: string, right: string): boolean {
  return normalize(decodeURIComponent(left).replace(/\\/gu, "/")) ===
    normalize(decodeURIComponent(right).replace(/\\/gu, "/"));
}

function lineAndColumn(text: string, needle: string): { line: number; column: number } {
  const lines = text.split("\n");
  const line = lines.findIndex((value) => value.includes(needle));
  if (line < 0) throw new Error(`Fixture needle was not found: ${needle}`);
  return { line: line + 1, column: lines[line]!.indexOf(needle) + 1 };
}

function locations(value: unknown): readonly Location[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const candidate = item as {
      uri?: unknown;
      range?: Location["range"];
      targetUri?: unknown;
      targetSelectionRange?: Location["range"];
    };
    if (typeof candidate.uri === "string" && candidate.range !== undefined) {
      return [{ uri: candidate.uri, range: candidate.range }];
    }
    if (typeof candidate.targetUri === "string" && candidate.targetSelectionRange !== undefined) {
      return [{ uri: candidate.targetUri, range: candidate.targetSelectionRange }];
    }
    return [];
  });
}

function symbolNames(value: unknown): readonly string[] {
  const names: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    const symbol = item as { name?: unknown; children?: unknown };
    if (typeof symbol.name === "string") names.push(symbol.name);
    if (Array.isArray(symbol.children)) symbol.children.forEach(visit);
  };
  if (Array.isArray(value)) value.forEach(visit);
  return names;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((complete) => setTimeout(complete, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await sleep(50);
  }
}

async function removeTemporaryRoot(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await rm(path, { force: true, recursive: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || Date.now() >= deadline) throw error;
      await sleep(100);
    }
  }
}

function observedFactory(observation: ConnectionObservation): LspConnectionFactory {
  return async (server) => {
    observation.factoryCount += 1;
    const connection = await createLspConnection(server);
    return {
      get capabilities() { return connection.capabilities; },
      get alive() { return connection.alive; },
      get pendingCount() { return connection.pendingCount; },
      supports: (method, document) => connection.supports(method, document),
      acceptsFileChanges: (path, type) => {
        const accepted = connection.acceptsFileChanges(path, type);
        observation.fileChangeAcceptances.push({ path, type, accepted });
        return accepted;
      },
      request: (method: LspRequestMethod, params: unknown, signal?: AbortSignal) => connection.request(method, params, signal),
      notify: async (method: LspNotificationMethod, params: unknown) => {
        await connection.notify(method, params);
        if (method !== "textDocument/didOpen") return;
        const textDocument = (params as { textDocument?: { uri?: unknown; text?: unknown; version?: unknown } }).textDocument;
        if (typeof textDocument?.uri === "string" && typeof textDocument.text === "string" &&
          Number.isSafeInteger(textDocument.version)) {
          observation.didOpens.push({ uri: textDocument.uri, text: textDocument.text, version: textDocument.version });
        }
      },
      dispose: () => connection.dispose(),
    } satisfies LspConnection;
  };
}

async function waitForWorkspaceSymbol(
  workspace: WorkspaceLsp,
  target: string,
  name: string,
): Promise<unknown> {
  const deadline = Date.now() + INITIAL_TIMEOUT_MS;
  let last: unknown;
  for (;;) {
    const response = await workspace.query({
      operation: "symbols",
      scope: "workspace",
      path: target,
      query: name,
      limit: 50,
    }, new AbortController().signal);
    last = response.value;
    if (symbolNames(last).includes(name)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`TLS initial project loading did not expose ${name}: ${JSON.stringify(last)}`);
    }
    await sleep(250);
  }
}

const suite = describe.skipIf(!optedIn);
suite("official TypeScript Language Server 4.3.3 production integration", () => {
  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
    if (temporaryRoot !== undefined) await removeTemporaryRoot(temporaryRoot);
    temporaryRoot = undefined;
  });

  it("uses one TLS connection for live source synchronization and reconnects honestly for unadvertised membership/config changes", async () => {
    const command = parseCommand();
    const serverPath = tsserverPath(command);
    expect((await stat(serverPath)).isFile()).toBe(true);
    temporaryRoot = await mkdtemp(join(tmpdir(), "piweb-typescript-integration-"));
    const fixtureRoot = join(temporaryRoot, "fixture");
    const sourceRoot = join(fixtureRoot, "src");
    const featureRoot = join(fixtureRoot, "feature");
    const configPath = join(temporaryRoot, "lsp.json");
    const programPath = join(sourceRoot, "program.ts");
    const helperPath = join(sourceRoot, "helper.ts");
    const addedPath = join(sourceRoot, "added.ts");
    const featurePath = join(featureRoot, "feature.ts");
    const helperUri = pathToFileURL(helperPath).href;
    await Promise.all([mkdir(sourceRoot, { recursive: true }), mkdir(featureRoot, { recursive: true })]);
    await Promise.all([
      writeFile(join(fixtureRoot, "package.json"), packageFile),
      writeFile(join(fixtureRoot, "tsconfig.json"), initialConfig),
      writeFile(programPath, programText),
      writeFile(helperPath, helperText),
      writeFile(featurePath, "export const FeatureEnabled = true;\n"),
      writeFile(configPath, JSON.stringify({
        version: 1,
        servers: [{
          id: "typescript",
          workspace: fixtureRoot,
          command,
          initializationOptions: { tsserver: { path: serverPath } },
        }],
      })),
    ]);

    const observation: ConnectionObservation = { factoryCount: 0, didOpens: [], fileChangeAcceptances: [] };
    const watcherEvents: WatchObservation[] = [];
    const workspace = new WorkspaceLsp(fixtureRoot, {
      resolveServer: (file) => resolveLspServer(fixtureRoot, file, configPath),
      createConnection: observedFactory(observation),
      watcherFactory: (cwd, ignored) => {
        const watcher = chokidar.watch(cwd, {
          atomic: true,
          followSymlinks: false,
          ignoreInitial: false,
          ignored,
          persistent: true,
        });
        watcher.on("all", (event, path) => watcherEvents.push({ event, path: resolve(cwd, path) }));
        return watcher;
      },
    });
    workspaces.push(workspace);

    const resolved = await resolveLspServer(fixtureRoot, programPath, configPath);
    expect(resolved.id).toBe("typescript");
    expect(resolved.watchFiles).toEqual([]);
    expect(resolved.initializationOptions).toEqual({ tsserver: { path: serverPath } });

    const documentSymbols = await workspace.query({
      operation: "symbols",
      scope: "document",
      path: programPath,
      limit: 50,
    }, new AbortController().signal);
    expect(symbolNames(documentSymbols.value)).toContain("value");
    await waitForWorkspaceSymbol(workspace, programPath, "helper");

    const call = lineAndColumn(programText, "helper(1)");
    const initialDefinition = await workspace.query({
      operation: "definition",
      path: programPath,
      ...call,
      limit: 10,
    }, new AbortController().signal);
    const originalHelper = locations(initialDefinition.value).find((location) => sameUri(location.uri, helperUri));
    expect(originalHelper, JSON.stringify(initialDefinition.value)).toBeDefined();
    const originalLine = originalHelper!.range.start.line;

    const references = await workspace.query({
      operation: "references",
      path: programPath,
      ...call,
      includeDeclaration: true,
      limit: 20,
    }, new AbortController().signal);
    const referenceLocations = locations(references.value);
    expect(referenceLocations.some((location) => sameUri(location.uri, pathToFileURL(programPath).href))).toBe(true);
    expect(referenceLocations.some((location) => sameUri(location.uri, helperUri))).toBe(true);
    expect(observation.didOpens.some((open) => open.uri === helperUri)).toBe(false);
    const initialFactoryCount = observation.factoryCount;

    await writeFile(helperPath, changedHelperText);
    await waitFor(
      () => watcherEvents.some((entry) => entry.event === "change" && normalize(entry.path) === normalize(helperPath)),
      WATCH_TIMEOUT_MS,
      "host Helper.ts change",
    );
    // This is intentionally the only query after the known source change.
    const changedDefinition = await workspace.query({
      operation: "definition",
      path: programPath,
      ...call,
      limit: 10,
    }, new AbortController().signal);
    const movedHelper = locations(changedDefinition.value).find((location) => sameUri(location.uri, helperUri));
    expect(movedHelper?.range.start.line).toBe(originalLine + 2);
    expect(observation.factoryCount).toBe(initialFactoryCount);
    expect(observation.didOpens.filter((open) => open.uri === helperUri).at(-1)?.text).toBe(changedHelperText);
    expect(observation.fileChangeAcceptances.some((entry) =>
      normalize(entry.path) === normalize(helperPath) && entry.type === 2 && entry.accepted === false,
    )).toBe(true);

    await writeFile(addedPath, "export const AddedType = true;\n");
    await waitFor(
      () => watcherEvents.some((entry) => entry.event === "add" && normalize(entry.path) === normalize(addedPath)),
      WATCH_TIMEOUT_MS,
      "host Added.ts add",
    );
    await expect(workspace.query({
      operation: "symbols",
      scope: "workspace",
      path: programPath,
      query: "AddedType",
      limit: 50,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "content_modified" });
    expect(observation.fileChangeAcceptances.some((entry) =>
      normalize(entry.path) === normalize(addedPath) && entry.type === 1 && entry.accepted === false,
    )).toBe(true);
    await waitForWorkspaceSymbol(workspace, programPath, "AddedType");
    expect(observation.factoryCount).toBe(initialFactoryCount + 1);

    await rm(addedPath);
    await waitFor(
      () => watcherEvents.some((entry) => entry.event === "unlink" && normalize(entry.path) === normalize(addedPath)),
      WATCH_TIMEOUT_MS,
      "host Added.ts unlink",
    );
    await expect(workspace.query({
      operation: "symbols",
      scope: "workspace",
      path: programPath,
      query: "AddedType",
      limit: 50,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "content_modified" });
    expect(observation.fileChangeAcceptances.some((entry) =>
      normalize(entry.path) === normalize(addedPath) && entry.type === 3 && entry.accepted === false,
    )).toBe(true);
    await waitForWorkspaceSymbol(workspace, programPath, "helper");
    const afterDelete = await workspace.query({
      operation: "symbols",
      scope: "workspace",
      path: programPath,
      query: "AddedType",
      limit: 50,
    }, new AbortController().signal);
    expect(symbolNames(afterDelete.value)).not.toContain("AddedType");
    expect(observation.factoryCount).toBe(initialFactoryCount + 2);

    await writeFile(join(fixtureRoot, "tsconfig.json"), configuredConfig);
    await waitFor(
      () => watcherEvents.some((entry) => entry.event === "change" &&
        normalize(entry.path) === normalize(join(fixtureRoot, "tsconfig.json"))),
      WATCH_TIMEOUT_MS,
      "host tsconfig.json change",
    );
    await expect(workspace.query({
      operation: "symbols",
      scope: "workspace",
      path: programPath,
      query: "FeatureEnabled",
      limit: 50,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "content_modified" });
    expect(observation.fileChangeAcceptances.some((entry) =>
      normalize(entry.path) === normalize(join(fixtureRoot, "tsconfig.json")) && entry.type === 2 && entry.accepted === false,
    )).toBe(true);
    await waitForWorkspaceSymbol(workspace, programPath, "FeatureEnabled");
    expect(observation.factoryCount).toBe(initialFactoryCount + 3);

    console.info("[typescript TLS integration]", JSON.stringify({
      factoryCount: observation.factoryCount,
      helperDidOpen: observation.didOpens.filter((open) => open.uri === helperUri).at(-1),
      fileChangeAcceptances: observation.fileChangeAcceptances,
      watcherEvents,
    }));
  }, 120_000);
});
