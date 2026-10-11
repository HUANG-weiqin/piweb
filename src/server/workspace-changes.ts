import { execFile, type ExecFileException } from "node:child_process";
import {
  MAX_WORKSPACE_CHANGE_FILES,
  type WorkspaceChangesSnapshot,
  type WorkspaceFileChange,
} from "../shared/protocol.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// Match workspaceFileChangeSchema's wire budget; never silently omit long paths.
const MAX_PATH_CHARACTERS = 4096;
const STATUS_TIMEOUT_MS = 5_000;
const STATUS_ARGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--ignore-submodules=none",
];
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
// The wire exposes one basic status, not both index/worktree columns. Structural
// changes win over modifications; conflict always wins, including on deduplication.
const STATUS_PRIORITY: Record<WorkspaceFileChange["status"], number> = {
  untracked: 0,
  modified: 1,
  type_changed: 2,
  added: 3,
  deleted: 4,
  copied: 5,
  renamed: 6,
  conflicted: 7,
};

type ReadySnapshot = Extract<WorkspaceChangesSnapshot, { state: "ready" }>;

function invalidOutput(): never {
  throw new Error("Invalid Git status output.");
}

function validatePath(path: string, allowTrailingSlash = false): void {
  // Porcelain v1 paths are repository-root-relative even from a nested cwd.
  // Preserve filename data. Even --untracked-files=all reports nested repository
  // boundaries with a slash; allow exactly that final slash only for untracked.
  const parts = (allowTrailingSlash && path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  if (!path || path.length > MAX_PATH_CHARACTERS || path.startsWith("/")
    || parts.some((part) => !part || part === "." || part === "..")) {
    invalidOutput();
  }
}

function basicStatus(code: string): WorkspaceFileChange["status"] {
  if (code === "??") return "untracked";
  if (CONFLICT_CODES.has(code)) return "conflicted";
  if (!/^(?: [MTDARC]|[MTARC][ MTD]|D )$/.test(code)) invalidOutput();
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("T")) return "type_changed";
  return "modified";
}

/** Parse complete porcelain v1 -z output; malformed or over-budget input throws. */
export function parseWorkspaceChanges(output: Buffer): ReadySnapshot {
  if (output.length > MAX_OUTPUT_BYTES) {
    throw new Error("Git status output exceeded the 4 MiB limit.");
  }
  let text: string;
  try {
    // Invalid filename bytes must not silently become replacement characters.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
  } catch {
    invalidOutput();
  }
  let offset = 0;
  const filesByPath = new Map<string, WorkspaceFileChange>();
  const nextField = (): string => {
    const end = text.indexOf("\0", offset);
    if (end < 0) invalidOutput();
    const field = text.slice(offset, end);
    offset = end + 1;
    return field;
  };
  while (offset < text.length) {
    const record = nextField();
    if (record.length < 4 || record[2] !== " ") invalidOutput();
    const code = record.slice(0, 2);
    const status = basicStatus(code);
    const path = record.slice(3);
    validatePath(path, code === "??");
    if (code.includes("R") || code.includes("C")) {
      // With -z, destination is first and the source is a separate NUL field.
      const source = nextField();
      validatePath(source);
      if (source === path) invalidOutput();
    }
    const previous = filesByPath.get(path);
    // Git can report a staged deletion and an untracked recreation at one path.
    if (!previous || STATUS_PRIORITY[status] > STATUS_PRIORITY[previous.status]) {
      filesByPath.set(path, { path, status });
    }
  }
  const files = [...filesByPath.values()].sort((a, b) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });
  return {
    state: "ready",
    files: files.slice(0, MAX_WORKSPACE_CHANGE_FILES),
    total: files.length,
    truncated: files.length > MAX_WORKSPACE_CHANGE_FILES,
  };
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Also remove COMMON_DIR, CONFIG_* and discovery overrides. None may redirect
    // the query or override fsmonitor/optional-lock policy (case-insensitive on Windows).
    const upper = key.toUpperCase();
    if (!upper.startsWith("GIT_") && upper !== "LC_ALL") env[key] = value;
  }
  env.LC_ALL = "C";
  return env;
}

function isNotGit(error: ExecFileException, stderr: Buffer): boolean {
  if (error.code !== 128 || error.killed || error.signal) return false;
  const message = stderr.toString("utf8").replaceAll("\r\n", "\n");
  return /^fatal: not a git repository \(or any of the parent directories\): \.git\n?$/.test(message)
    || /^fatal: not a git repository \(or any parent up to mount point [^\n]+\)\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\n?$/.test(message)
    || /^fatal: this operation must be run in a work tree\n?$/.test(message);
}

/** One fresh, read-only, bounded Git observation. No diff, index writes or cache. */
export async function readWorkspaceChanges(
  cwd: string,
  signal?: AbortSignal,
): Promise<WorkspaceChangesSnapshot> {
  if (signal?.aborted) return { state: "error", message: "Git status read was aborted." };
  try {
    const result = await new Promise<{
      error: ExecFileException | null;
      stdout: Buffer;
      stderr: Buffer;
      overflow: boolean;
    }>((resolve) => {
      let bytes = 0;
      let overflow = false;
      const child = execFile("git", STATUS_ARGS, {
        cwd,
        env: gitEnvironment(),
        encoding: "buffer",
        shell: false,
        windowsHide: true,
        timeout: STATUS_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr, overflow }));
      // execFile's maxBuffer is per stream; impose the same aggregate output cap.
      const countOutput = (chunk: Buffer): void => {
        bytes += chunk.length;
        if (!overflow && bytes > MAX_OUTPUT_BYTES) {
          overflow = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.kill("SIGKILL");
        }
      };
      child.stdout?.on("data", countOutput);
      child.stderr?.on("data", countOutput);
    });
    if (signal?.aborted || result.error?.code === "ABORT_ERR") {
      return { state: "error", message: "Git status read was aborted." };
    }
    if (result.overflow || result.stdout.length + result.stderr.length > MAX_OUTPUT_BYTES
      || result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { state: "error", message: "Git status output exceeded the 4 MiB limit." };
    }
    if (result.error) {
      if (result.stdout.length === 0 && isNotGit(result.error, result.stderr)) {
        return { state: "not_git" };
      }
      return {
        state: "error",
        message: result.error.killed
          ? "Git status timed out or was terminated."
          : "Git status could not be read.",
      };
    }
    return parseWorkspaceChanges(result.stdout);
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error && error.message === "Invalid Git status output."
        ? error.message
        : "Git status could not be read.",
    };
  }
}
