import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { LSP_MAX_RESULT_BYTES, LspError } from "./contracts.js";
import { resolveLspServer } from "./definition.js";
import { createLspConnection } from "./connection.js";
import { createLspTools } from "./tools.js";
import type { LspConnection, LspConnectionFactory } from "./contracts.js";
import { WorkspaceLsp } from "./workspace.js";

/**
 * This suite is deliberately opt-in. The command and runtime are user-owned
 * prerequisites; the default test command must never install, download, or
 * start Roslyn.
 */
const commandJson = process.env.PIWEB_LSP_ROSLYN_COMMAND;
const dotnetRoot = process.env.PIWEB_LSP_ROSLYN_DOTNET_ROOT;
const optedIn = commandJson !== undefined && dotnetRoot !== undefined;

const projectFile = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`.trimStart();

const solutionFile = `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.0.31903.59
MinimumVisualStudioVersion = 10.0.40219.1
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Fixture", "Fixture.csproj", "{7B2F4E80-64F4-4C4D-9E2F-0C3C1E7C8B28}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|Any CPU = Debug|Any CPU
		Release|Any CPU = Release|Any CPU
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
		{7B2F4E80-64F4-4C4D-9E2F-0C3C1E7C8B28}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
		{7B2F4E80-64F4-4C4D-9E2F-0C3C1E7C8B28}.Debug|Any CPU.Build.0 = Debug|Any CPU
		{7B2F4E80-64F4-4C4D-9E2F-0C3C1E7C8B28}.Release|Any CPU.ActiveCfg = Release|Any CPU
		{7B2F4E80-64F4-4C4D-9E2F-0C3C1E7C8B28}.Release|Any CPU.Build.0 = Release|Any CPU
	EndGlobalSection
EndGlobal
`;

const programFile = `using System;
using RoslynFixture;

namespace RoslynFixture;

public static class Program
{
    public static void Main()
    {
        var result = "😀".Length + Helper.Run(1);
        Console.WriteLine(result);
    }
}
`;

const helperFile = `namespace RoslynFixture;

public static class Helper
{
    public static int Run(int value) => value + 1;
}
`;

const featureFile = `#if PIWEB_ROSLYN_FEATURE_XYZ
namespace RoslynFixture;

public static class FeatureEnabled
{
    public static int Value => 42;
}
#endif
`;

const nugetConfig = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
  </packageSources>
</configuration>
`;

const featureProjectFile = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <DefineConstants>PIWEB_ROSLYN_FEATURE_XYZ</DefineConstants>
  </PropertyGroup>
</Project>
`.trimStart();

type ProjectedRange = {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
};

type ProjectedItem = {
  readonly name?: string;
  readonly kind?: number;
  readonly path?: string;
  readonly range?: ProjectedRange;
  readonly disk?: { readonly line: number; readonly text: string; readonly observation: string };
};

type ProjectedDetails = {
  readonly status: string;
  readonly server: string;
  readonly root: string;
  readonly positionEncoding: string;
  readonly items: readonly ProjectedItem[];
  readonly truncated: boolean;
};

type ToolResult = {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly details: unknown;
};

type RetryEvidence = {
  readonly phase: string;
  readonly retry: number;
  readonly at: string;
  readonly elapsedMs: number;
  readonly reason: "cancelled" | "content_modified" | "predicate";
  readonly error?: string;
};

type DidOpenObservation = {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
};

type ConnectionObservation = {
  factoryCount: number;
  readonly didOpens: DidOpenObservation[];
};

const WARMUP_TIMEOUT_MS = 60_000;
const CHANGE_RETRY_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 500;
const execFileAsync = promisify(execFile);

let temporaryRoot: string | undefined;
let fixtureRoot: string;
let configPath: string;
let workspace: WorkspaceLsp;
const workspaces: WorkspaceLsp[] = [];

function observedConnectionFactory(observation: ConnectionObservation): LspConnectionFactory {
  return async (server) => {
    observation.factoryCount += 1;
    const connection = await createLspConnection(server);
    const observed: LspConnection = {
      get capabilities() { return connection.capabilities; },
      get alive() { return connection.alive; },
      get pendingCount() { return connection.pendingCount; },
      supports: (method, document) => connection.supports(method, document),
      acceptsFileChanges: (path, type) => connection.acceptsFileChanges(path, type),
      request: (method, params, signal) => connection.request(method, params, signal),
      notify: async (method, params) => {
        await connection.notify(method, params);
        if (method === "textDocument/didOpen") {
          const data = params as { textDocument?: { uri?: unknown; version?: unknown; text?: unknown } };
          const document = data.textDocument;
          if (typeof document?.uri === "string" && Number.isSafeInteger(document.version) && typeof document.text === "string") {
            observation.didOpens.push({ uri: document.uri, version: document.version, text: document.text });
          }
        }
      },
      dispose: () => connection.dispose(),
    };
    return observed;
  };
}

function parseCommand(): [string, ...string[]] {
  let value: unknown;
  try {
    value = JSON.parse(commandJson ?? "");
  } catch (error) {
    throw new Error("PIWEB_LSP_ROSLYN_COMMAND must be a JSON argv array", { cause: error });
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error("PIWEB_LSP_ROSLYN_COMMAND must be a non-empty JSON argv array");
  }
  return value as [string, ...string[]];
}

function lineAndColumn(text: string, needle: string): { line: number; column: number } {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`Fixture needle was not found: ${needle}`);
  const column = lines[index]!.indexOf(needle) + 1;
  return { line: index + 1, column };
}

function projectResult(result: unknown): ProjectedDetails {
  const typed = result as ToolResult;
  const text = typed.content[0]?.text;
  expect(typeof text).toBe("string");
  expect(Buffer.byteLength(text ?? "", "utf8")).toBeLessThanOrEqual(LSP_MAX_RESULT_BYTES);
  expect(typed.details).toMatchObject({
    status: "ok",
    server: "roslyn",
    root: fixtureRoot,
    positionEncoding: "utf-16",
  });
  return typed.details as ProjectedDetails;
}

async function invoke(
  tool: ToolDefinition,
  input: unknown,
  signal = new AbortController().signal,
): Promise<ProjectedDetails> {
  const result = await tool.execute("roslyn-integration", input as never, signal, undefined, {} as never);
  return projectResult(result);
}

function errorSummary(error: unknown, depth = 0): string {
  if (depth > 4) return "<cause-depth-limit>";
  if (error instanceof Error) {
    const code = error instanceof LspError ? ` code=${error.code}` :
      typeof (error as { code?: unknown }).code === "number" ? ` code=${String((error as { code: number }).code)}` : "";
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause === undefined ? "" : `; cause=${errorSummary(cause, depth + 1)}`;
    return `${error.name}${code}: ${error.message}${causeText}`;
  }
  return String(error);
}

function isServerCancelled(error: unknown): error is LspError {
  return error instanceof LspError && error.code === "cancelled";
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function removeTemporaryRoot(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      if (Date.now() >= deadline) throw error;
      await sleep(100);
    }
  }
}

async function runDotnetPreflight(cwd: string, privateToolState: string): Promise<void> {
  const env = {
    ...process.env,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
    DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "false",
    DOTNET_CLI_HOME: join(privateToolState, "home"),
    NUGET_PACKAGES: join(privateToolState, "packages"),
    NUGET_HTTP_CACHE_PATH: join(privateToolState, "http-cache"),
    NUGET_PLUGINS_CACHE_PATH: join(privateToolState, "plugins-cache"),
  };
  delete env.DOTNET_ROOT;
  delete env.DOTNET_ROOT_X64;
  const options = { cwd, env, windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024 };
  let sdkList: { stdout: string; stderr: string };
  try {
    sdkList = await execFileAsync("dotnet", ["--list-sdks"], options);
  } catch (error) {
    throw new Error(`dotnet --list-sdks failed: ${errorSummary(error)}`, { cause: error });
  }
  console.info(`[roslyn dotnet preflight] --list-sdks stdout=${JSON.stringify(sdkList.stdout.trim())} stderr=${JSON.stringify(sdkList.stderr.trim())}`);
  if (!/^8\./mu.test(sdkList.stdout)) {
    throw new Error(`dotnet SDK 8.x was not available: ${JSON.stringify(sdkList.stdout.trim())}`);
  }
  let restore: { stdout: string; stderr: string };
  try {
    restore = await execFileAsync("dotnet", [
      "restore",
      "Fixture.csproj",
      "--disable-build-servers",
      "--configfile",
      join(cwd, "NuGet.Config"),
      "--force",
      "--no-cache",
    ], options);
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string };
    throw new Error(
      `dotnet restore failed: ${errorSummary(error)}; stdout=${JSON.stringify(detail.stdout ?? "")}; stderr=${JSON.stringify(detail.stderr ?? "")}`,
      { cause: error },
    );
  }
  console.info(`[roslyn dotnet preflight] restore stdout=${JSON.stringify(restore.stdout.trim())} stderr=${JSON.stringify(restore.stderr.trim())}`);
}

async function warmup(
  tool: ToolDefinition,
  input: unknown,
  phase: "initial" | "rebuild",
  evidence: RetryEvidence[],
  callerSignal: AbortSignal,
): Promise<ProjectedDetails> {
  const timeoutController = new AbortController();
  const signal = AbortSignal.any([callerSignal, timeoutController.signal]);
  const started = Date.now();
  const timeout = setTimeout(() => timeoutController.abort(), WARMUP_TIMEOUT_MS);
  timeout.unref?.();
  let retryCount = 0;
  try {
    for (;;) {
      if (callerSignal.aborted) {
        throw new LspError("cancelled", `Roslyn ${phase} warmup caller was cancelled`);
      }
      if (timeoutController.signal.aborted) {
        throw new Error(
          `Roslyn ${phase} warmup did not converge within ${WARMUP_TIMEOUT_MS}ms; ` +
          `retryCount=${retryCount}; evidence=${JSON.stringify(evidence)}`,
        );
      }
      try {
        const result = await invoke(tool, input, signal);
        console.info(`[roslyn warmup] phase=${phase} retryCount=${retryCount} evidence=${JSON.stringify(evidence)}`);
        return result;
      } catch (error) {
        if (callerSignal.aborted) throw error;
        if (timeoutController.signal.aborted) {
          throw new Error(
            `Roslyn ${phase} warmup timed out after ${WARMUP_TIMEOUT_MS}ms; ` +
            `retryCount=${retryCount}; evidence=${JSON.stringify(evidence)}`,
            { cause: error },
          );
        }
        // Only the official server's cancelled response is a warmup retry.
        // Unsupported, unavailable, misconfigured, and all other failures escape.
        if (!isServerCancelled(error)) {
          console.error(
            `[roslyn warmup] phase=${phase} retryCount=${retryCount} ` +
            `evidence=${JSON.stringify(evidence)} terminal=${errorSummary(error)}`,
          );
          throw error;
        }
        retryCount += 1;
        evidence.push({
          phase,
          retry: retryCount,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - started,
          reason: "cancelled",
          error: errorSummary(error),
        });
        await sleep(RETRY_DELAY_MS);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function queryUntil(
  tool: ToolDefinition,
  input: unknown,
  phase: string,
  predicate: (result: ProjectedDetails) => boolean,
  evidence: RetryEvidence[],
  allowServerCancelled = false,
): Promise<ProjectedDetails> {
  const callerController = new AbortController();
  const timeoutController = new AbortController();
  const signal = AbortSignal.any([callerController.signal, timeoutController.signal]);
  const started = Date.now();
  const timeout = setTimeout(() => timeoutController.abort(), CHANGE_RETRY_TIMEOUT_MS);
  timeout.unref?.();
  let retryCount = 0;
  let lastResult: ProjectedDetails | undefined;
  try {
    for (;;) {
      if (timeoutController.signal.aborted) {
        throw new Error(
          `Roslyn ${phase} predicate did not converge within ${CHANGE_RETRY_TIMEOUT_MS}ms; ` +
          `lastResponse=${JSON.stringify(lastResult)}`,
        );
      }
      try {
        const result = await invoke(tool, input, signal);
        lastResult = result;
        if (predicate(result)) return result;
        retryCount += 1;
        evidence.push({
          phase,
          retry: retryCount,
          at: new Date().toISOString(),
          elapsedMs: Date.now() - started,
          reason: "predicate",
        });
      } catch (error) {
        if (callerController.signal.aborted) throw error;
        if (timeoutController.signal.aborted) {
          throw new Error(
            `Roslyn ${phase} predicate timed out after ${CHANGE_RETRY_TIMEOUT_MS}ms; ` +
            `lastResponse=${JSON.stringify(lastResult)}`,
            { cause: error },
          );
        }
        if (error instanceof LspError && error.code === "content_modified") {
          retryCount += 1;
          evidence.push({
            phase,
            retry: retryCount,
            at: new Date().toISOString(),
            elapsedMs: Date.now() - started,
            reason: "content_modified",
            error: errorSummary(error),
          });
        } else if (allowServerCancelled && isServerCancelled(error)) {
          retryCount += 1;
          evidence.push({
            phase,
            retry: retryCount,
            at: new Date().toISOString(),
            elapsedMs: Date.now() - started,
            reason: "cancelled",
            error: errorSummary(error),
          });
        } else {
          // Unsupported, unavailable, misconfigured, and caller cancellation
          // are terminal; this is never a generic retry loop.
          throw error;
        }
      }
      await sleep(RETRY_DELAY_MS);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function toolsFor(service: WorkspaceLsp): {
  readonly symbols: ToolDefinition;
  readonly definition: ToolDefinition;
  readonly references: ToolDefinition;
} {
  const tools = createLspTools(fixtureRoot, service);
  return {
    symbols: tools.find((tool) => tool.name === "lsp_symbols")!,
    definition: tools.find((tool) => tool.name === "lsp_definition")!,
    references: tools.find((tool) => tool.name === "lsp_references")!,
  };
}

const suite = describe.skipIf(!optedIn);
suite("official Roslyn 5.12.0-1.26426.8 production LSP integration", () => {
  beforeEach(async () => {
    temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "piweb-roslyn-integration-")));
    fixtureRoot = join(temporaryRoot, "fixture");
    configPath = join(temporaryRoot, "lsp.json");
    await mkdir(fixtureRoot, { recursive: true });

    await Promise.all([
      writeFile(join(fixtureRoot, "Fixture.sln"), solutionFile),
      writeFile(join(fixtureRoot, "Fixture.csproj"), projectFile),
      writeFile(join(fixtureRoot, "Program.cs"), programFile),
      writeFile(join(fixtureRoot, "Helper.cs"), helperFile),
      writeFile(join(fixtureRoot, "Feature.cs"), featureFile),
      writeFile(join(fixtureRoot, "NuGet.Config"), nugetConfig),
    ]);

    const command = parseCommand();
    expect(basename(command[0]!).toLowerCase()).toBe("microsoft.codeanalysis.languageserver.exe");
    expect(command.slice(1)).toEqual(["--stdio", "--autoLoadProjects"]);
    const privateToolState = join(temporaryRoot, "tool-state");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      servers: [{
        id: "roslyn",
        workspace: fixtureRoot,
        command,
        env: {
          DOTNET_ROOT: dotnetRoot,
          DOTNET_ROOT_X64: dotnetRoot,
          ROSLYN_LANGUAGE_SERVER_DAEMON_KEEPALIVE: "0",
          DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
          DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
          DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: "false",
          DOTNET_CLI_HOME: join(privateToolState, "home"),
          NUGET_PACKAGES: join(privateToolState, "packages"),
          NUGET_HTTP_CACHE_PATH: join(privateToolState, "http-cache"),
          NUGET_PLUGINS_CACHE_PATH: join(privateToolState, "plugins-cache"),
        },
      }],
    }));
    await runDotnetPreflight(fixtureRoot, privateToolState);
  });

  afterEach(async () => {
    await Promise.all(workspaces.splice(0).map((service) => service.dispose()));
    if (temporaryRoot !== undefined) await removeTemporaryRoot(temporaryRoot);
    temporaryRoot = undefined;
  });

  it("validates production symbols, cross-file navigation, live disk/project changes, and rebuild", async () => {
    const programPath = "Program.cs";
    const helperPath = "Helper.cs";
    const helperAbsolute = pathToFileURL(join(fixtureRoot, helperPath)).href.toLowerCase();
    let resolveHelperChange!: () => void;
    const helperChangeObserved = new Promise<void>((resolve) => { resolveHelperChange = resolve; });
    const connectionObservation: ConnectionObservation = { factoryCount: 0, didOpens: [] };
    const makeWorkspace = (): WorkspaceLsp => {
      const service = new WorkspaceLsp(fixtureRoot, {
        resolveServer: (file) => resolveLspServer(fixtureRoot, file, configPath),
        createConnection: observedConnectionFactory(connectionObservation),
        watcherFactory: (cwd, ignored) => {
          const watcher = chokidar.watch(cwd, {
            atomic: true,
            followSymlinks: false,
            ignoreInitial: false,
            ignored,
            persistent: true,
          });
          watcher.on("all", (event, changedPath) => {
            const observedPath = pathToFileURL(changedPath).href.toLowerCase();
            if (event === "change" && observedPath === helperAbsolute) resolveHelperChange();
          });
          return watcher;
        },
      });
      workspaces.push(service);
      return service;
    };

    workspace = makeWorkspace();
    const firstTools = toolsFor(workspace);
    const retryEvidence: RetryEvidence[] = [];
    const initialWarmupSignal = new AbortController().signal;

    const documentSymbols = await warmup(firstTools.symbols, {
      path: programPath,
      scope: "document",
      limit: 50,
    }, "initial", retryEvidence, initialWarmupSignal);
    expect(documentSymbols.items.length).toBeGreaterThan(0);
    console.info("[roslyn documentSymbols]", JSON.stringify(documentSymbols.items.map((item) => ({
      name: item.name,
      kind: item.kind,
      path: item.path,
      range: item.range,
    }))));
    expect(documentSymbols.items.some((item) => item.name === "Program")).toBe(true);
    expect(documentSymbols.items.some((item) => item.kind === 6 && /^Main(?:$|\()/.test(item.name ?? ""))).toBe(true);

    const workspaceSymbols = await queryUntil(firstTools.symbols, {
      path: programPath,
      scope: "workspace",
      query: "Helper",
      limit: 20,
    }, "initial-workspace-symbols", (result) => result.items.some((item) => item.name === "Helper" && item.path === helperPath), retryEvidence);
    expect(workspaceSymbols.items.length).toBeGreaterThan(0);
    expect(workspaceSymbols.items.some((item) => item.name === "Helper" && item.path === helperPath)).toBe(true);

    const programText = await readFile(join(fixtureRoot, programPath), "utf8");
    const runPosition = lineAndColumn(programText, "Run");
    const definition = await invoke(firstTools.definition, {
      path: programPath,
      ...runPosition,
      limit: 10,
    });
    expect(definition.items.length).toBeGreaterThan(0);
    expect(definition.items.some((item) => item.path === helperPath)).toBe(true);
    expect(definition.items.find((item) => item.path === helperPath)?.disk?.text).toContain("Run(int value)");

    const referencesWithoutDeclaration = await invoke(firstTools.references, {
      path: programPath,
      ...runPosition,
      includeDeclaration: false,
      limit: 20,
    });
    const referencesWithDeclaration = await invoke(firstTools.references, {
      path: programPath,
      ...runPosition,
      includeDeclaration: true,
      limit: 20,
    });
    expect(referencesWithoutDeclaration.items.length).toBeGreaterThan(0);
    expect(referencesWithoutDeclaration.items.some((item) => item.path === programPath)).toBe(true);
    expect(referencesWithoutDeclaration.items.some((item) => item.path === helperPath)).toBe(false);
    expect(referencesWithDeclaration.items.length).toBeGreaterThan(referencesWithoutDeclaration.items.length);
    expect(referencesWithDeclaration.items.some((item) => item.path === helperPath)).toBe(true);
    expect(referencesWithDeclaration.items.some((item) => item.path === programPath)).toBe(true);

    const originalDefinition = definition.items.find((item) => item.path === helperPath);
    const originalDefinitionLine = originalDefinition?.range?.start.line;
    expect(originalDefinitionLine).toBeDefined();

    const helperUri = pathToFileURL(join(fixtureRoot, helperPath)).href;
    expect(connectionObservation.didOpens.some((open) => open.uri === helperUri)).toBe(false);
    const initialFactoryCount = connectionObservation.factoryCount;

    // Helper.cs was never an LSP target, so this exercises a watcher update for
    // an unopened dependency rather than didChange on a mirrored document.
    const shiftedHelperFile = helperFile.replace(
      "    public static int Run(int value) => value + 1;",
      "    public static int InsertedOne => 1;\n    public static int InsertedTwo => 2;\n    public static int Run(int value) => value + 2;",
    );
    await writeFile(join(fixtureRoot, helperPath), shiftedHelperFile);
    const helperEventTimeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for host-observed Helper.cs change")), CHANGE_RETRY_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([helperChangeObserved, helperEventTimeout]);
    const changedDefinition = await invoke(firstTools.definition, {
      path: programPath,
      ...runPosition,
      limit: 10,
    });
    const movedDefinition = changedDefinition.items.find((item) => item.path === helperPath);
    expect(movedDefinition?.range?.start.line).toBe(originalDefinitionLine! + 2);
    expect(movedDefinition?.disk?.line).toBe(movedDefinition?.range?.start.line);
    expect(movedDefinition?.disk?.text).toContain("Run(int value)");
    expect(movedDefinition?.disk?.text).toContain("value + 2");
    expect(connectionObservation.factoryCount).toBe(initialFactoryCount);
    const helperDidOpens = connectionObservation.didOpens.filter((open) => open.uri === helperUri);
    expect(helperDidOpens.length).toBeGreaterThan(0);
    expect(helperDidOpens.at(-1)?.text).toBe(shiftedHelperFile);

    await writeFile(join(fixtureRoot, "Added.cs"), `namespace RoslynFixture;\n\npublic static class AddedType\n{\n    public static int Value => 1;\n}\n`);
    const addedSymbols = await queryUntil(firstTools.symbols, {
      path: programPath,
      scope: "workspace",
      query: "AddedType",
      limit: 20,
    }, "source-add", (result) => result.items.some((item) => item.name === "AddedType" && item.path === "Added.cs"), retryEvidence);
    expect(addedSymbols.items.length).toBeGreaterThan(0);
    expect(addedSymbols.items.some((item) => item.name === "AddedType" && item.path === "Added.cs")).toBe(true);

    await rm(join(fixtureRoot, "Added.cs"));
    const deletedSymbols = await queryUntil(firstTools.symbols, {
      path: programPath,
      scope: "workspace",
      query: "AddedType",
      limit: 20,
    }, "source-delete", (result) => !result.items.some((item) => item.name === "AddedType"), retryEvidence);
    expect(deletedSymbols.items.some((item) => item.name === "AddedType")).toBe(false);

    const absentFeatureSymbols = await invoke(firstTools.symbols, {
      path: programPath,
      scope: "workspace",
      query: "FeatureEnabled",
      limit: 20,
    });
    expect(absentFeatureSymbols.items.some((item) => item.name === "FeatureEnabled")).toBe(false);

    await writeFile(join(fixtureRoot, "Fixture.csproj"), featureProjectFile);
    const configuredSymbols = await queryUntil(firstTools.symbols, {
      path: programPath,
      scope: "workspace",
      query: "FeatureEnabled",
      limit: 20,
    }, "project-config-change", (result) => result.items.some((item) => item.name === "FeatureEnabled" && item.path === "Feature.cs"), retryEvidence, true);
    expect(configuredSymbols.items.length).toBeGreaterThan(0);
    expect(configuredSymbols.items.some((item) => item.name === "FeatureEnabled" && item.path === "Feature.cs")).toBe(true);

    await workspace.dispose();
    workspace = makeWorkspace();
    const rebuiltTools = toolsFor(workspace);
    const rebuildWarmupSignal = new AbortController().signal;
    const rebuiltSymbols = await warmup(rebuiltTools.symbols, {
      path: programPath,
      scope: "document",
      limit: 50,
    }, "rebuild", retryEvidence, rebuildWarmupSignal);
    expect(rebuiltSymbols.items.length).toBeGreaterThan(0);
    expect(rebuiltSymbols.items.some((item) => item.name === "Program")).toBe(true);
  }, 120_000);
});
