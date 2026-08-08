import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const GIT_INSPECT_TIMEOUT_MS = 10_000;
const GIT_INSPECT_MAX_BYTES = 50 * 1024;
const GIT_INSPECT_MAX_LINES = 2_000;
const GIT_INSPECT_MAX_PATH_CHARS = 1_024;
const REPOSITORY_CAPTURE_MAX_BYTES = 64 * 1024;
const REPOSITORY_CAPTURE_MAX_LINES = 64;

const gitStatusParameters = Type.Object({
  path: Type.Optional(Type.String({
    minLength: 1,
    maxLength: GIT_INSPECT_MAX_PATH_CHARS,
  })),
}, { additionalProperties: false });

const gitDiffParameters = Type.Object({
  scope: Type.String({ enum: ["worktree", "staged", "all"] }),
  path: Type.Optional(Type.String({
    minLength: 1,
    maxLength: GIT_INSPECT_MAX_PATH_CHARS,
  })),
}, { additionalProperties: false });

type GitStatusInput = Static<typeof gitStatusParameters>;
type GitDiffInput = Static<typeof gitDiffParameters>;
type GitDiffScope = "worktree" | "staged" | "all";

function normalizeGitDiffScope(scope: GitDiffInput["scope"]): GitDiffScope {
  if (scope !== "worktree" && scope !== "staged" && scope !== "all") {
    throw new Error("Invalid git_diff scope");
  }
  return scope;
}

export interface GitInspectDetails {
  action: "status" | "diff";
  scope?: GitDiffScope;
  path?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface GitInspectProcessOptions {
  /** Test seam. Production callers must use the resolved host Git binary. */
  executable?: string;
  argsPrefix?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
}

interface OutputBudget {
  bytesRemaining: number;
  linesRemaining: number;
  lineOpen: Record<"stdout" | "stderr", boolean>;
  truncated: boolean;
}

interface GitProcessResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`)
      && pathFromRoot !== ".."
      && !isAbsolute(pathFromRoot));
}

function safeExecutable(candidate: string, canonicalCwd: string): string | undefined {
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile() || isWithin(canonicalCwd, resolved)) {
      return;
    }
    accessSync(resolved, fsConstants.X_OK);
    return resolved;
  } catch {
    return;
  }
}

function hostGitCandidates(env: NodeJS.ProcessEnv): string[] {
  const pathValue = Object.entries(env).find(
    ([key]) => key.toUpperCase() === "PATH",
  )?.[1] ?? "";
  const executableName = process.platform === "win32" ? "git.exe" : "git";
  const candidates = pathValue.split(delimiter).flatMap((entry) => {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    return directory && isAbsolute(directory)
      ? [resolve(directory, executableName)]
      : [];
  });

  if (process.platform === "win32") {
    for (const root of [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"),
    ]) {
      if (!root) continue;
      candidates.push(join(root, "Git", "cmd", "git.exe"));
      candidates.push(join(root, "Git", "bin", "git.exe"));
    }
  } else {
    candidates.push("/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git");
  }
  return candidates;
}

function resolveHostGit(canonicalCwd: string): string {
  const seen = new Set<string>();
  for (const candidate of hostGitCandidates(process.env)) {
    const executable = safeExecutable(candidate, canonicalCwd);
    if (!executable || seen.has(executable)) continue;
    seen.add(executable);
    return executable;
  }
  throw new Error("Could not find a safe host Git executable");
}

function cleanGitEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_") && value !== undefined) {
      env[key] = value;
    }
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  env.PAGER = "cat";
  return { ...env, ...overrides };
}

function validateProjectPath(
  projectPath: string | undefined,
  canonicalCwd: string,
): string | undefined {
  if (projectPath === undefined) return;
  if (projectPath.includes("\0")) {
    throw new Error("Git path must not contain a NUL byte");
  }
  if (isAbsolute(projectPath) || win32.isAbsolute(projectPath)) {
    throw new Error("Git path must be relative to the project");
  }

  const resolved = resolve(canonicalCwd, projectPath);
  if (!isWithin(canonicalCwd, resolved)) {
    throw new Error("Git path escapes the project directory");
  }
  return projectPath;
}

function gitArgs(
  action: "status" | "diff",
  scope: Exclude<GitDiffScope, "all"> | undefined,
  projectPath: string | undefined,
): string[] {
  const args = [
    "--no-pager",
    "--no-optional-locks",
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "color.ui=false",
  ];
  if (action === "status") {
    args.push(
      "status",
      "--porcelain=v1",
      "--branch",
      "--untracked-files=all",
      "--ignore-submodules=all",
    );
  } else {
    args.push(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
    );
    if (scope === "staged") args.push("--cached");
  }
  args.push("--", projectPath ?? ".");
  return args;
}

function createBudget(
  maxOutputBytes: number,
  maxOutputLines: number,
): OutputBudget {
  return {
    bytesRemaining: maxOutputBytes,
    linesRemaining: maxOutputLines,
    lineOpen: { stdout: false, stderr: false },
    truncated: false,
  };
}

function takeOutput(
  chunk: Buffer,
  channel: "stdout" | "stderr",
  budget: OutputBudget,
): Buffer {
  let end = 0;
  while (end < chunk.length && budget.bytesRemaining > 0) {
    if (!budget.lineOpen[channel]) {
      if (budget.linesRemaining === 0) break;
      budget.linesRemaining--;
      budget.lineOpen[channel] = true;
    }
    const byte = chunk[end];
    end++;
    budget.bytesRemaining--;
    if (byte === 0x0a) budget.lineOpen[channel] = false;
  }
  if (end < chunk.length) budget.truncated = true;
  return chunk.subarray(0, end);
}

function abortError(): Error {
  const error = new Error("Git inspection was aborted");
  error.name = "AbortError";
  return error;
}

function runGit(
  executable: string,
  argsPrefix: readonly string[],
  args: readonly string[],
  canonicalCwd: string,
  signal: AbortSignal | undefined,
  deadline: number,
  budget: OutputBudget,
  environment: NodeJS.ProcessEnv = {},
  acceptedExitCodes: readonly number[] = [0],
): Promise<GitProcessResult> {
  if (signal?.aborted) return Promise.reject(abortError());
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new Error("Git inspection timed out"));
  }
  if (budget.bytesRemaining === 0 || budget.linesRemaining === 0) {
    budget.truncated = true;
    return Promise.resolve({ stdout: "", stderr: "", truncated: true });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let stopReason: "abort" | "timeout" | "truncated" | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let hardStopTimer: NodeJS.Timeout | undefined;

    const child = spawn(executable, [...argsPrefix, ...args], {
      cwd: canonicalCwd,
      env: cleanGitEnvironment(environment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (error?: Error, exitCode?: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);

      if (error) {
        rejectPromise(error);
        return;
      }
      const stdoutBytes = Buffer.concat(stdout);
      const stderrBytes = Buffer.concat(stderr);
      const result = {
        stdout: stdoutBytes.toString("utf8"),
        stderr: stderrBytes.toString("utf8"),
        truncated: budget.truncated,
      };
      if (stopReason === "abort") {
        rejectPromise(abortError());
      } else if (stopReason === "timeout") {
        rejectPromise(new Error("Git inspection timed out"));
      } else if (stopReason === "truncated") {
        resolvePromise({ ...result, truncated: true });
      } else if (exitCode == null || !acceptedExitCodes.includes(exitCode)) {
        const message = result.stderr.trim() || `Git exited with code ${exitCode}`;
        rejectPromise(new Error(message));
      } else {
        resolvePromise(result);
      }
    };

    const requestStop = (
      reason: "abort" | "timeout" | "truncated",
    ): void => {
      if (stopReason === "abort" || stopReason === "timeout") return;
      stopReason = reason;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
      forceKillTimer.unref();
      hardStopTimer ??= setTimeout(() => {
        finish(stopReason === "abort" ? abortError() : new Error(
          stopReason === "timeout"
            ? "Git inspection timed out"
            : "Git inspection could not stop after output truncation",
        ));
      }, 1_000);
      hardStopTimer.unref();
    };

    const onAbort = (): void => requestStop("abort");
    const onStdout = (chunk: Buffer): void => {
      if (stopReason) return;
      const kept = takeOutput(chunk, "stdout", budget);
      if (kept.length > 0) stdout.push(kept);
      if (budget.truncated) requestStop("truncated");
    };
    const onStderr = (chunk: Buffer): void => {
      if (stopReason) return;
      const kept = takeOutput(chunk, "stderr", budget);
      if (kept.length > 0) stderr.push(kept);
      if (budget.truncated) requestStop("truncated");
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (code: number | null): void => finish(undefined, code);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const timeoutTimer = setTimeout(() => requestStop("timeout"), remainingMs);
    timeoutTimer.unref();
  });
}

interface RepositorySandbox {
  environment: NodeJS.ProcessEnv;
  dispose(): void;
}

function repositoryCaptureArgs(): string[] {
  return [
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-path",
    "index",
    "--git-path",
    "objects",
    "--show-object-format=storage",
    "--verify",
    "--quiet",
    "HEAD",
  ];
}

function safeHeadRef(value: string): boolean {
  if (!value.startsWith("ref: refs/heads/")) return false;
  const parts = value.slice("ref: ".length).split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

async function createRepositorySandbox(
  executable: string,
  canonicalCwd: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<RepositorySandbox> {
  const captured = await runGit(
    executable,
    [],
    repositoryCaptureArgs(),
    canonicalCwd,
    signal,
    deadline,
    createBudget(REPOSITORY_CAPTURE_MAX_BYTES, REPOSITORY_CAPTURE_MAX_LINES),
    {},
    [0, 1],
  );
  if (captured.truncated) {
    throw new Error("Git repository metadata exceeded its safety limit");
  }
  const fields = captured.stdout.trimEnd().split(/\r?\n/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error("Git returned invalid repository metadata");
  }
  const [topLevel, gitDirectory, indexPath, objectDirectory, objectFormat] = fields;
  const repositoryTop = realpathSync(topLevel);
  const resolvedGitDirectory = realpathSync(gitDirectory);
  const resolvedObjectDirectory = realpathSync(objectDirectory);
  if (
    !isWithin(repositoryTop, canonicalCwd)
    || !statSync(resolvedGitDirectory).isDirectory()
    || !statSync(resolvedObjectDirectory).isDirectory()
    || !isAbsolute(indexPath)
    || (objectFormat !== "sha1" && objectFormat !== "sha256")
  ) {
    throw new Error("Git returned unsafe repository metadata");
  }

  const expectedHashLength = objectFormat === "sha256" ? 64 : 40;
  const headHash = fields[5];
  if (
    headHash !== undefined
    && !new RegExp(`^[0-9a-f]{${expectedHashLength}}$`).test(headHash)
  ) {
    throw new Error("Git returned an invalid HEAD object id");
  }

  const sandboxDirectory = mkdtempSync(join(tmpdir(), "piweb-git-inspect-"));
  try {
    const emptyConfig = join(sandboxDirectory, "empty-config");
    writeFileSync(emptyConfig, "");
    const config = [
      "[core]",
      `\trepositoryformatversion = ${objectFormat === "sha256" ? 1 : 0}`,
      "\tbare = false",
      ...(objectFormat === "sha256"
        ? ["[extensions]", "\tobjectFormat = sha256"]
        : []),
      "",
    ].join("\n");
    writeFileSync(join(sandboxDirectory, "config"), config);

    let head = headHash ?? "ref: refs/heads/piweb-unborn";
    try {
      const realHeadPath = join(resolvedGitDirectory, "HEAD");
      const headStat = lstatSync(realHeadPath, { throwIfNoEntry: false });
      if (headStat?.isFile() && headStat.size <= 1_024) {
        const candidate = readFileSync(realHeadPath, "utf8").trim();
        if (safeHeadRef(candidate)) head = candidate;
      }
    } catch {
      // A detached or unreadable HEAD remains detached in the sandbox.
    }
    writeFileSync(join(sandboxDirectory, "HEAD"), `${head}\n`);
    if (headHash && head.startsWith("ref: ")) {
      const refPath = resolve(
        sandboxDirectory,
        ...head.slice("ref: ".length).split("/"),
      );
      if (!isWithin(sandboxDirectory, refPath)) {
        throw new Error("Git returned an unsafe HEAD ref");
      }
      mkdirSync(resolve(refPath, ".."), { recursive: true });
      writeFileSync(refPath, `${headHash}\n`);
    }

    return {
      environment: {
        GIT_DIR: sandboxDirectory,
        GIT_WORK_TREE: repositoryTop,
        GIT_INDEX_FILE: indexPath,
        GIT_OBJECT_DIRECTORY: resolvedObjectDirectory,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_SYSTEM: emptyConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
        HOME: sandboxDirectory,
        XDG_CONFIG_HOME: sandboxDirectory,
      },
      dispose(): void {
        rmSync(sandboxDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(sandboxDirectory, { recursive: true, force: true });
    throw error;
  }
}

function boundCombinedOutput(
  stdout: string,
  stderr: string,
  maxOutputBytes: number,
  maxOutputLines: number,
): { stdout: string; stderr: string; truncated: boolean } {
  const budget = createBudget(maxOutputBytes, maxOutputLines);
  const boundedStdout = takeOutput(Buffer.from(stdout), "stdout", budget);
  const boundedStderr = takeOutput(Buffer.from(stderr), "stderr", budget);
  return {
    stdout: boundedStdout.toString("utf8"),
    stderr: boundedStderr.toString("utf8"),
    truncated: budget.truncated,
  };
}

function contentText(details: GitInspectDetails): string {
  const output = [details.stdout, details.stderr]
    .filter((value) => value.length > 0)
    .join("\n");
  const base = output || (details.action === "status"
    ? "Working tree is clean."
    : "No differences.");
  return details.truncated
    ? `${base}\n\nOutput was truncated; specify a narrower path.`
    : base;
}

interface GitToolContext {
  boundCwd: string;
  repositoryExecutable: string;
  executable: string;
  argsPrefix: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  maxOutputLines: number;
}

function createGitToolContext(
  canonicalCwd: string,
  processOptions: GitInspectProcessOptions,
): GitToolContext {
  const boundCwd = realpathSync(canonicalCwd);
  const repositoryExecutable = resolveHostGit(boundCwd);
  const executable = processOptions.executable === undefined
    ? repositoryExecutable
    : safeExecutable(processOptions.executable, boundCwd);
  if (!executable) {
    throw new Error("Git executable must be an absolute executable outside the project");
  }
  return {
    boundCwd,
    repositoryExecutable,
    executable,
    argsPrefix: [...(processOptions.argsPrefix ?? [])],
    timeoutMs: processOptions.timeoutMs ?? GIT_INSPECT_TIMEOUT_MS,
    maxOutputBytes: processOptions.maxOutputBytes ?? GIT_INSPECT_MAX_BYTES,
    maxOutputLines: processOptions.maxOutputLines ?? GIT_INSPECT_MAX_LINES,
  };
}

async function executeGitInspection(
  context: GitToolContext,
  action: "status" | "diff",
  input: GitStatusInput | (GitDiffInput & { scope: GitDiffScope }),
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GitInspectDetails }> {
  const projectPath = validateProjectPath(input.path, context.boundCwd);
  const deadline = Date.now() + context.timeoutMs;
  const sandbox = await createRepositorySandbox(
    context.repositoryExecutable,
    context.boundCwd,
    signal,
    deadline,
  );
  try {
    const budget = createBudget(context.maxOutputBytes, context.maxOutputLines);
    const scope = action === "diff"
      ? (input as GitDiffInput & { scope: GitDiffScope }).scope
      : undefined;
    let stdout = "";
    let stderr = "";
    let truncated = false;

    if (action === "status") {
      const result = await runGit(
        context.executable,
        context.argsPrefix,
        gitArgs("status", undefined, projectPath),
        context.boundCwd,
        signal,
        deadline,
        budget,
        sandbox.environment,
      );
      stdout = result.stdout;
      stderr = result.stderr;
      truncated = result.truncated;
    } else if (scope === "all") {
      const staged = await runGit(
        context.executable,
        context.argsPrefix,
        gitArgs("diff", "staged", projectPath),
        context.boundCwd,
        signal,
        deadline,
        budget,
        sandbox.environment,
      );
      stdout = `### Staged changes\n${staged.stdout || "(no differences)"}\n`;
      stderr = staged.stderr;
      truncated = staged.truncated;
      if (!truncated) {
        const worktree = await runGit(
          context.executable,
          context.argsPrefix,
          gitArgs("diff", "worktree", projectPath),
          context.boundCwd,
          signal,
          deadline,
          budget,
          sandbox.environment,
        );
        stdout += `### Worktree changes\n${worktree.stdout || "(no differences)"}`;
        stderr = [stderr, worktree.stderr].filter(Boolean).join("\n");
        truncated = worktree.truncated;
      }
    } else {
      const result = await runGit(
        context.executable,
        context.argsPrefix,
        gitArgs("diff", scope, projectPath),
        context.boundCwd,
        signal,
        deadline,
        budget,
        sandbox.environment,
      );
      stdout = result.stdout;
      stderr = result.stderr;
      truncated = result.truncated;
    }

    const bounded = boundCombinedOutput(
      stdout,
      stderr,
      context.maxOutputBytes,
      context.maxOutputLines,
    );
    const details: GitInspectDetails = {
      action,
      ...(scope === undefined ? {} : { scope }),
      ...(projectPath === undefined ? {} : { path: projectPath }),
      stdout: bounded.stdout,
      stderr: bounded.stderr,
      truncated: truncated || bounded.truncated,
    };
    return {
      content: [{ type: "text", text: contentText(details) }],
      details,
    };
  } finally {
    sandbox.dispose();
  }
}

function createGitStatusToolFromContext(context: GitToolContext): ToolDefinition {
  return defineTool({
    name: "git_status",
    label: "Git status",
    description:
      "Inspect the current project's Git status through a fixed read-only operation. Use path to narrow large output.",
    promptSnippet: "Inspect bounded Git status without changing the project.",
    parameters: gitStatusParameters,
    async execute(_toolCallId, rawInput, signal) {
      if (!Check(gitStatusParameters, rawInput)) {
        throw new Error("Invalid git_status input");
      }
      return executeGitInspection(
        context,
        "status",
        rawInput as GitStatusInput,
        signal,
      );
    },
  });
}

function createGitDiffToolFromContext(context: GitToolContext): ToolDefinition {
  return defineTool({
    name: "git_diff",
    label: "Git diff",
    description:
      "Inspect the current project's Git diff through fixed read-only operations. Use path to narrow large output.",
    promptSnippet: "Inspect bounded Git diffs without changing the project.",
    parameters: gitDiffParameters,
    async execute(_toolCallId, rawInput, signal) {
      if (!Check(gitDiffParameters, rawInput)) {
        throw new Error("Invalid git_diff input");
      }
      const input = rawInput as GitDiffInput;
      return executeGitInspection(
        context,
        "diff",
        { ...input, scope: normalizeGitDiffScope(input.scope) },
        signal,
      );
    },
  });
}

export function createGitTools(
  canonicalCwd: string,
  processOptions: GitInspectProcessOptions = {},
): ToolDefinition[] {
  const context = createGitToolContext(canonicalCwd, processOptions);
  return [
    createGitStatusToolFromContext(context),
    createGitDiffToolFromContext(context),
  ];
}
