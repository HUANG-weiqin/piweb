import {
  ChildProcess,
  execFile,
  execFileSync,
  type ExecFileException,
  type ExecFileOptions,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_WORKSPACE_CHANGE_FILES, type WorkspaceFileChange } from "../shared/protocol.js";
import { parseWorkspaceChanges, readWorkspaceChanges } from "./workspace-changes.js";

// Only the external process boundary is mocked; ordinary cases use real Git.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const execMock = vi.mocked(execFile);
const temporaryDirectories: string[] = [];
const OUTPUT_LIMIT = 4 * 1024 * 1024;

afterEach(() => {
  vi.unstubAllEnvs();
  execMock.mockReset().mockImplementation(actual.execFile);
  for (const path of temporaryDirectories.reverse()) {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
  temporaryDirectories.length = 0;
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "piweb-workspace-changes-"));
  temporaryDirectories.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  return execFileSync("git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${join(cwd, ".git", "disabled-hooks")}`,
    "-c", "commit.gpgSign=false", ...args,
  ], { cwd, env: { ...env, LC_ALL: "C" }, encoding: "utf8", windowsHide: true, timeout: 10_000 });
}

function write(cwd: string, path: string, content = "content\n"): void {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

function repository(files: Record<string, string> = {}): string {
  const cwd = temporaryDirectory();
  git(cwd, "init", "--initial-branch=main", "--template=");
  git(cwd, "config", "user.email", "piweb@example.invalid");
  git(cwd, "config", "user.name", "Pi Web Test");
  git(cwd, "config", "core.autocrlf", "false");
  git(cwd, "config", "core.excludesFile", join(cwd, ".git", "no-global-ignores"));
  git(cwd, "config", "status.renames", "true");
  for (const [path, content] of Object.entries(files)) write(cwd, path, content);
  if (Object.keys(files).length) {
    git(cwd, "add", "--all");
    git(cwd, "commit", "-m", "fixture");
  }
  return cwd;
}

function ready(files: WorkspaceFileChange[], total = files.length) {
  return { state: "ready", files, total, truncated: total > files.length };
}

function parse(text: string) {
  return parseWorkspaceChanges(Buffer.from(text));
}

function failure(properties: Partial<ExecFileException>): ExecFileException {
  return Object.assign(new Error("fixture process failure"), properties);
}

type ExecCallback = (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void;

function mockProcess(
  run: (child: ChildProcess, options: ExecFileOptions, callback: ExecCallback) => void,
): void {
  execMock.mockImplementationOnce(((
    _file: string, _args: string[], options: ExecFileOptions, callback: ExecCallback,
  ) => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => run(child, options, callback));
    return child;
  }) as typeof execFile);
}

function mockResult(error: ExecFileException | null, stdout = "", stderr = ""): void {
  mockProcess((_child, _options, callback) => callback(error, Buffer.from(stdout), Buffer.from(stderr)));
}

describe("parseWorkspaceChanges", () => {
  it("accepts a complete empty observation", () => {
    expect(parse("")).toEqual(ready([]));
  });

  it("preserves spaces, Unicode, tabs, newlines and rename destination order", () => {
    expect(parse("RM 新 名\t\n.txt\0旧 名\n\t.txt\0??  leading space.txt\0 M 中文.txt\0"))
      .toEqual(ready([
        { path: " leading space.txt", status: "untracked" },
        { path: "中文.txt", status: "modified" },
        { path: "新 名\t\n.txt", status: "renamed" },
      ]));
  });

  it.each(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])("reports %s as conflicted", (code) => {
    expect(parse(`${code} conflict.txt\0`))
      .toEqual(ready([{ path: "conflict.txt", status: "conflicted" }]));
  });

  it.each([
    ["MM", "modified"], [" M", "modified"], ["M ", "modified"],
    ["A ", "added"], ["AM", "added"], [" A", "added"],
    ["D ", "deleted"], [" D", "deleted"], ["MD", "deleted"], ["AD", "deleted"],
    ["T ", "type_changed"], [" T", "type_changed"], ["TM", "type_changed"],
  ] as const)("projects %s to %s", (code, status) => {
    expect(parse(`${code} file.txt\0`)).toEqual(ready([{ path: "file.txt", status }]));
  });

  it.each([
    ["R ", "renamed"], [" R", "renamed"], ["RD", "renamed"],
    ["C ", "copied"], [" C", "copied"], ["CT", "copied"],
  ] as const)("consumes the source field for %s", (code, status) => {
    expect(parse(`${code} target.txt\0source.txt\0?? another.txt\0`)).toEqual(ready([
      { path: "another.txt", status: "untracked" },
      { path: "target.txt", status },
    ]));
  });

  it("deduplicates paths with an order-independent basic status and stable ordering", () => {
    const first = "?? recreated.txt\0D  recreated.txt\0 M a\0T  a\0UU a\0?? A\0";
    const second = "?? A\0UU a\0T  a\0 M a\0D  recreated.txt\0?? recreated.txt\0";
    const expected = ready([
      { path: "A", status: "untracked" },
      { path: "a", status: "conflicted" },
      { path: "recreated.txt", status: "deleted" },
    ]);
    expect(parse(first)).toEqual(expected);
    expect(parse(second)).toEqual(expected);
  });

  it("counts the complete unique output before limiting the sorted list", () => {
    const total = MAX_WORKSPACE_CHANGE_FILES + 7;
    const records = Array.from({ length: total }, (_, index) =>
      `?? file-${String(index).padStart(4, "0")}\0`).reverse().join("");
    const snapshot = parse(records + " M file-0000\0");
    expect(snapshot.total).toBe(total);
    expect(snapshot.files).toHaveLength(MAX_WORKSPACE_CHANGE_FILES);
    expect(snapshot.files[0]).toEqual({ path: "file-0000", status: "modified" });
    expect(snapshot.files.at(-1)?.path).toBe("file-0499");
    expect(snapshot.truncated).toBe(true);
    expect(() => parse(records + "?? unterminated")).toThrow("Invalid Git status output");
    expect(parse(records.slice(records.indexOf("?? file-0499"))).truncated).toBe(false);
  });

  it("preserves and deduplicates untracked repository boundary paths", () => {
    expect(parse("?? nested/\0?? nested/\0?? parent/中文 仓库/\0"))
      .toEqual(ready([
        { path: "nested/", status: "untracked" },
        { path: "parent/中文 仓库/", status: "untracked" },
      ]));
  });

  it.each([
    "\0", " M file", " M\0", " M \0", " Mxfile\0", "ZZ file\0", "   file\0",
    "!! ignored\0", "U  file\0", "DM file\0", " M file\0garbage", " M file\0\0",
    "R  target\0", "C  target\0\0", "R  target\0target\0", "R  target\0../old\0",
    " M folder/\0", "A  folder/\0", "D  folder/\0", "T  folder/\0", "UU folder/\0",
    "R  target/\0source\0", "C  target/\0source\0",
    "R  target\0source/\0", "C  target\0source/\0",
    "?? /absolute\0", "?? ../escape\0", "?? a/../escape\0",
    "?? ./file\0", "?? a//file\0", "?? folder//\0", "?? parent//nested/\0",
    "?? parent/../nested/\0", "?? ../nested/\0", "?? ./nested/\0", "?? /nested/\0",
    "?? /\0", "?? ./\0", "?? ../\0", "?? parent/./nested/\0",
  ])("rejects malformed/incomplete output %j", (text) => {
    expect(() => parse(text)).toThrow("Invalid Git status output");
  });

  it("preserves literal backslashes and trailing filename whitespace", () => {
    expect(parse("?? back\\slash \t.txt \0"))
      .toEqual(ready([{ path: "back\\slash \t.txt ", status: "untracked" }]));
  });

  it("fails rather than emitting paths beyond the wire budget", () => {
    const path = "x".repeat(4096);
    expect(parse(`?? ${path}\0`)).toEqual(ready([{ path, status: "untracked" }]));
    expect(() => parse(`?? ${path}x\0`)).toThrow("Invalid Git status output");
  });

  it("rejects invalid UTF-8 rather than corrupting filenames", () => {
    expect(() => parseWorkspaceChanges(Buffer.from([63, 63, 32, 0xff, 0])))
      .toThrow("Invalid Git status output");
  });

  it("rejects over-budget stdout even if the visible prefix would be empty", () => {
    expect(() => parseWorkspaceChanges(Buffer.alloc(OUTPUT_LIMIT + 1)))
      .toThrow("4 MiB");
  });
});

describe("readWorkspaceChanges with real temporary Git repositories", () => {
  it("reads empty repositories, with or without HEAD", async () => {
    const cwd = repository();
    expect(await readWorkspaceChanges(cwd)).toEqual(ready([]));
    write(cwd, "tracked.txt");
    git(cwd, "add", "--all");
    git(cwd, "commit", "-m", "fixture");
    expect(await readWorkspaceChanges(cwd)).toEqual(ready([]));
  }, 20_000);

  it("counts a staged plus unstaged path once", async () => {
    const cwd = repository({ "tracked.txt": "initial\n" });
    write(cwd, "tracked.txt", "staged\n");
    git(cwd, "add", "tracked.txt");
    write(cwd, "tracked.txt", "unstaged\n");
    expect(await readWorkspaceChanges(cwd))
      .toEqual(ready([{ path: "tracked.txt", status: "modified" }]));
  }, 20_000);

  it("enumerates untracked files, honors ignores, and preserves Unicode/space paths", async () => {
    const cwd = repository({ ".gitignore": "ignored.txt\nignored-dir/\n" });
    write(cwd, "ignored.txt");
    write(cwd, "ignored-dir/hidden.txt");
    write(cwd, "new folder/a.txt");
    write(cwd, "new folder/中文 文件.txt");
    write(cwd, "新 文件.txt");
    expect(await readWorkspaceChanges(cwd)).toEqual(ready([
      { path: "new folder/a.txt", status: "untracked" },
      { path: "new folder/中文 文件.txt", status: "untracked" },
      { path: "新 文件.txt", status: "untracked" },
    ]));
  }, 20_000);

  it("preserves an untracked nested Git repository boundary as one status path", async () => {
    const cwd = repository();
    write(cwd, "nested/inner.txt");
    git(join(cwd, "nested"), "init", "--initial-branch=main", "--template=");
    const output = git(cwd, "status", "--porcelain=v1", "-z",
      "--untracked-files=all", "--ignore-submodules=none");
    expect(output).toBe("?? nested/\0");
    expect(await readWorkspaceChanges(cwd))
      .toEqual(ready([{ path: "nested/", status: "untracked" }]));
  }, 20_000);

  it("reports added and staged/unstaged deleted files", async () => {
    const cwd = repository({ "staged.txt": "old\n", "unstaged.txt": "old\n" });
    git(cwd, "rm", "staged.txt");
    rmSync(join(cwd, "unstaged.txt"));
    write(cwd, "added.txt");
    git(cwd, "add", "added.txt");
    write(cwd, "added.txt", "unstaged addition\n");
    expect(await readWorkspaceChanges(cwd)).toEqual(ready([
      { path: "added.txt", status: "added" },
      { path: "staged.txt", status: "deleted" },
      { path: "unstaged.txt", status: "deleted" },
    ]));
  }, 20_000);

  it("reports the destination of a staged rename, not its NUL source field", async () => {
    const cwd = repository({ "旧 名.txt": "initial\n" });
    git(cwd, "mv", "旧 名.txt", "新 名.txt");
    write(cwd, "新 名.txt", "unstaged content\n");
    expect(await readWorkspaceChanges(cwd))
      .toEqual(ready([{ path: "新 名.txt", status: "renamed" }]));
  }, 20_000);

  it("deduplicates a staged deletion and untracked recreation", async () => {
    const cwd = repository({ "recreated.txt": "initial\n" });
    git(cwd, "rm", "recreated.txt");
    write(cwd, "recreated.txt", "recreated\n");
    expect(await readWorkspaceChanges(cwd))
      .toEqual(ready([{ path: "recreated.txt", status: "deleted" }]));
  }, 20_000);

  it("returns whole-worktree root-relative paths from a nested cwd", async () => {
    const cwd = repository({ "root.txt": "initial\n", "nested/tracked.txt": "initial\n" });
    git(cwd, "config", "status.relativePaths", "true");
    write(cwd, "root.txt", "changed\n");
    write(cwd, "nested/tracked.txt", "changed\n");
    write(cwd, "nested/deeper/新 文件.txt");
    const snapshot = await readWorkspaceChanges(join(cwd, "nested", "deeper"));
    expect(snapshot).toEqual(ready([
      { path: "nested/deeper/新 文件.txt", status: "untracked" },
      { path: "nested/tracked.txt", status: "modified" },
      { path: "root.txt", status: "modified" },
    ]));
    expect(await readWorkspaceChanges(cwd)).toEqual(snapshot);
  }, 20_000);

  it("observes a linked worktree independently of the original worktree", async () => {
    const cwd = repository({ "nested/tracked.txt": "initial\n" });
    const linked = join(temporaryDirectory(), "linked");
    git(cwd, "worktree", "add", "--detach", linked, "HEAD");
    write(cwd, "original-only.txt");
    write(linked, "nested/tracked.txt", "linked change\n");
    expect(await readWorkspaceChanges(join(linked, "nested")))
      .toEqual(ready([{ path: "nested/tracked.txt", status: "modified" }]));
  }, 20_000);

  it("does not refresh index bytes/mtime or invoke a configured fsmonitor hook", async () => {
    const cwd = repository({ "tracked.txt": "same content\n" });
    const marker = join(cwd, ".git", "fsmonitor-invoked");
    const hook = join(cwd, ".git", "fsmonitor-hook");
    writeFileSync(hook, `#!/bin/sh\nprintf invoked > '${marker.replaceAll("\\", "/")}'\n`, { mode: 0o755 });
    git(cwd, "config", "core.fsmonitor", hook);
    write(cwd, "tracked.txt", "same content\n");
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(join(cwd, "tracked.txt"), oldTime, oldTime);
    const index = join(cwd, ".git", "index");
    const bytes = readFileSync(index);
    const metadata = statSync(index, { bigint: true });
    expect(await readWorkspaceChanges(cwd)).toEqual(ready([]));
    expect(await readWorkspaceChanges(cwd)).toEqual(ready([]));
    expect(readFileSync(index)).toEqual(bytes);
    expect(statSync(index, { bigint: true }).mtimeNs).toBe(metadata.mtimeNs);
    expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it("ignores inherited Git repository/index/config redirection", async () => {
    const cwd = repository({ "tracked.txt": "initial\n" });
    const other = repository({ "other.txt": "initial\n" });
    write(cwd, "tracked.txt", "changed\n");
    write(other, "wrong-repository.txt");
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    vi.stubEnv("GIT_COMMON_DIR", join(other, ".git"));
    vi.stubEnv("GIT_WORK_TREE", other);
    vi.stubEnv("GIT_INDEX_FILE", join(other, ".git", "index"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "malicious-hook");
    expect(await readWorkspaceChanges(cwd))
      .toEqual(ready([{ path: "tracked.txt", status: "modified" }]));
    expect(execMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("distinguishes an ordinary non-repository and a bare repository", async () => {
    const directory = temporaryDirectory();
    expect(await readWorkspaceChanges(directory)).toEqual({ state: "not_git" });
    git(directory, "init", "--bare", "--template=");
    expect(await readWorkspaceChanges(directory)).toEqual({ state: "not_git" });
  }, 20_000);

  it("reports an invalid cwd as error, never empty or not_git", async () => {
    expect(await readWorkspaceChanges(join(temporaryDirectory(), "missing")))
      .toMatchObject({ state: "error" });
  });
});

describe("readWorkspaceChanges external failure boundaries", () => {
  it("makes exactly one fixed non-shell query with a 5s/4MiB budget", async () => {
    mockResult(null, "?? file\0");
    expect(await readWorkspaceChanges("chosen-cwd"))
      .toEqual(ready([{ path: "file", status: "untracked" }]));
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith("git", [
      "--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1",
      "-z", "--untracked-files=all", "--ignore-submodules=none",
    ], expect.objectContaining({
      cwd: "chosen-cwd", encoding: "buffer", shell: false, windowsHide: true,
      timeout: 5_000, maxBuffer: OUTPUT_LIMIT, killSignal: "SIGKILL",
      env: expect.objectContaining({ LC_ALL: "C" }),
    }), expect.any(Function));
    const options = execMock.mock.calls[0][2] as ExecFileOptions;
    expect(Object.keys(options.env!).some((key) => key.toUpperCase().startsWith("GIT_"))).toBe(false);
  });

  it.each([
    { code: "ENOENT" },
    { code: 1 },
    { code: 128 },
    { killed: true, signal: "SIGKILL", code: null },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    { code: "ABORT_ERR" },
  ] as const)("returns error for process failure %j, ignoring partial valid output", async (properties) => {
    mockResult(failure(properties), "?? partial.txt\0");
    expect(await readWorkspaceChanges("cwd")).toMatchObject({ state: "error" });
  });

  it("does not reinterpret corruption, unsafe repositories or misleading diagnostics as not_git", async () => {
    for (const stderr of [
      "fatal: not a git repository: broken/.git\n",
      "fatal: detected dubious ownership in repository\n",
      "other error\nfatal: not a git repository (or any of the parent directories): .git\n",
    ]) {
      mockResult(failure({ code: 128 }), "", stderr);
      expect(await readWorkspaceChanges("cwd")).toMatchObject({ state: "error" });
    }
    mockResult(failure({ code: "ENOENT" }), "",
      "fatal: not a git repository (or any of the parent directories): .git\n");
    expect(await readWorkspaceChanges("cwd")).toMatchObject({ state: "error" });
  });

  it("recognizes the filesystem-boundary non-repository diagnostic", async () => {
    mockResult(failure({ code: 128 }), "",
      "fatal: not a git repository (or any parent up to mount point /mount)\n"
      + "Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n");
    expect(await readWorkspaceChanges("cwd")).toEqual({ state: "not_git" });
  });

  it("returns error for successful but malformed output", async () => {
    mockResult(null, "?? incomplete");
    expect(await readWorkspaceChanges("cwd"))
      .toEqual({ state: "error", message: "Invalid Git status output." });
  });

  it("returns error for invalid UTF-8 filename bytes", async () => {
    mockProcess((_child, _options, callback) =>
      callback(null, Buffer.from([63, 63, 32, 0xff, 0]), Buffer.alloc(0)));
    expect(await readWorkspaceChanges("cwd"))
      .toEqual({ state: "error", message: "Invalid Git status output." });
  });

  it("rejects stdout over budget even if an external adapter fails to report overflow", async () => {
    mockResult(null, "x".repeat(OUTPUT_LIMIT + 1));
    expect(await readWorkspaceChanges("cwd")).toMatchObject({ state: "error", message: expect.stringContaining("4 MiB") });
  });

  it("bounds aggregate stdout+stderr, stops the child, and rejects partial output", async () => {
    mockProcess((child, _options, callback) => {
      child.stdout!.emit("data", Buffer.alloc(OUTPUT_LIMIT));
      child.stderr!.emit("data", Buffer.from("overflow"));
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(child.stdout!.destroyed).toBe(true);
      expect(child.stderr!.destroyed).toBe(true);
      callback(failure({ killed: true }), Buffer.from("?? partial\0"), Buffer.alloc(0));
    });
    expect(await readWorkspaceChanges("cwd")).toMatchObject({ state: "error", message: expect.stringContaining("4 MiB") });
  });

  it("does not spawn Git for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await readWorkspaceChanges("cwd", controller.signal))
      .toEqual({ state: "error", message: "Git status read was aborted." });
    expect(execMock).not.toHaveBeenCalled();
  });

  it("passes cancellation to execFile and never treats a late success as empty", async () => {
    const controller = new AbortController();
    mockProcess((_child, options, callback) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      callback(null, Buffer.alloc(0), Buffer.alloc(0));
    });
    expect(await readWorkspaceChanges("cwd", controller.signal))
      .toEqual({ state: "error", message: "Git status read was aborted." });
  });

  it("turns synchronous spawn failures into an error snapshot", async () => {
    execMock.mockImplementationOnce(() => { throw new Error("spawn failure"); });
    expect(await readWorkspaceChanges("cwd")).toMatchObject({ state: "error" });
  });
});
