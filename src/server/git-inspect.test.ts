import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitInspectTool,
  type GitInspectDetails,
} from "./git-inspect.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: GitInspectDetails;
}

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryGit(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // Sentinel commands intentionally do not implement Git hook protocols.
  }
}

function createRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "piweb-git-inspect-"));
  temporaryDirectories.push(cwd);
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.email", "piweb@example.invalid");
  git(cwd, "config", "user.name", "Pi Web Test");
  writeFileSync(join(cwd, "tracked.txt"), "initial\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "-m", "initial");
  return cwd;
}

function executeTool(
  tool: ToolDefinition,
  input: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  return tool.execute(
    "tool-call",
    input as never,
    signal,
    undefined,
    undefined as never,
  ) as Promise<ToolResult>;
}

function nodeBackedTool(
  cwd: string,
  script: string,
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    maxOutputLines?: number;
  } = {},
): ToolDefinition {
  return createGitInspectTool(cwd, {
    executable: process.execPath,
    argsPrefix: ["-e", script, "--"],
    ...options,
  });
}

function shellQuotedPath(path: string): string {
  return `"${path.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
}

function createSentinel(cwd: string): { command: string; marker: string } {
  const marker = join(cwd, "sentinel-fired");
  const script = join(cwd, "sentinel.cjs");
  writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "fired");\n`,
  );
  return {
    command: `${shellQuotedPath(process.execPath)} ${shellQuotedPath(script)}`,
    marker,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createGitInspectTool", () => {
  it("exposes only the structured status and diff schema", async () => {
    const cwd = createRepository();
    const schema = createGitInspectTool(cwd).parameters;

    expect(JSON.stringify(schema)).not.toMatch(/anyOf|oneOf/);
    expect(Check(schema, { action: "status" })).toBe(true);
    expect(Check(schema, {
      action: "diff",
      scope: "staged",
      path: "src/server",
    })).toBe(true);
    expect(Check(schema, { action: "status", args: ["reset", "--hard"] }))
      .toBe(false);
    expect(Check(schema, { action: "diff", scope: "unknown" })).toBe(false);
    expect(Check(schema, { action: "log" })).toBe(false);
    await expect(executeTool(createGitInspectTool(cwd), { action: "diff" }))
      .rejects.toThrow(/requires a scope/i);
    await expect(executeTool(createGitInspectTool(cwd), {
      action: "status",
      scope: "staged",
    })).rejects.toThrow(/does not accept/i);
  });

  it("rejects absolute, NUL, and escaping paths while allowing dot", async () => {
    const cwd = createRepository();
    const tool = createGitInspectTool(cwd);

    await expect(executeTool(tool, { action: "status", path: "/outside" }))
      .rejects.toThrow(/relative/i);
    await expect(executeTool(tool, { action: "status", path: "C:\\outside" }))
      .rejects.toThrow(/relative/i);
    await expect(executeTool(tool, { action: "status", path: "../outside" }))
      .rejects.toThrow(/escapes/i);
    await expect(executeTool(tool, { action: "status", path: "bad\0path" }))
      .rejects.toThrow(/NUL/i);
    await expect(executeTool(tool, { action: "status", path: "." }))
      .resolves.toMatchObject({ details: { action: "status", path: "." } });
  });

  it("reports status and worktree, staged, and combined diffs", async () => {
    const cwd = createRepository();
    const tool = createGitInspectTool(cwd);
    writeFileSync(join(cwd, "tracked.txt"), "staged\n");
    git(cwd, "add", "tracked.txt");
    writeFileSync(join(cwd, "tracked.txt"), "worktree\n");
    writeFileSync(join(cwd, "untracked.txt"), "untracked\n");

    const status = await executeTool(tool, { action: "status" });
    const staged = await executeTool(tool, {
      action: "diff",
      scope: "staged",
    });
    const worktree = await executeTool(tool, {
      action: "diff",
      scope: "worktree",
    });
    const all = await executeTool(tool, { action: "diff", scope: "all" });

    expect(status.details.stdout).toContain("tracked.txt");
    expect(status.details.stdout).toContain("untracked.txt");
    expect(staged.details.stdout).toContain("+staged");
    expect(worktree.details.stdout).toContain("+worktree");
    expect(all.details.stdout).toContain("### Staged changes");
    expect(all.details.stdout).toContain("### Worktree changes");
  });

  it("keeps implicit status and diff paths inside a nested project cwd", async () => {
    const repository = createRepository();
    const cwd = join(repository, "project");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "inside.txt"), "inside\n");
    writeFileSync(join(repository, "secret.txt"), "secret\n");
    git(repository, "add", "project/inside.txt", "secret.txt");
    git(repository, "commit", "-m", "nested project");
    writeFileSync(join(cwd, "inside.txt"), "inside worktree\n");
    writeFileSync(join(repository, "secret.txt"), "outside worktree\n");
    const tool = createGitInspectTool(cwd);

    const status = await executeTool(tool, { action: "status" });
    const worktree = await executeTool(tool, {
      action: "diff",
      scope: "worktree",
    });
    expect(status.details.stdout).toContain("inside.txt");
    expect(status.details.stdout).not.toContain("secret.txt");
    expect(worktree.details.stdout).toContain("inside worktree");
    expect(worktree.details.stdout).not.toContain("outside worktree");

    git(repository, "add", "project/inside.txt", "secret.txt");
    const staged = await executeTool(tool, { action: "diff", scope: "staged" });
    const all = await executeTool(tool, { action: "diff", scope: "all" });
    expect(staged.details.stdout).toContain("inside worktree");
    expect(staged.details.stdout).not.toContain("outside worktree");
    expect(all.details.stdout).not.toContain("outside worktree");
  });

  it("treats a path beginning with -- as a pathspec, not a Git option", async () => {
    const cwd = createRepository();
    const outputPath = join(cwd, "owned.patch");

    await executeTool(createGitInspectTool(cwd), {
      action: "diff",
      scope: "worktree",
      path: "--output=owned.patch",
    });

    expect(existsSync(outputPath)).toBe(false);
  });

  it("neutralizes executable Git config and preserves the worktree and index", async () => {
    const cwd = createRepository();
    const { command, marker } = createSentinel(cwd);
    writeFileSync(join(cwd, ".gitattributes"), "tracked.txt diff=sentinel\n");
    git(cwd, "add", ".gitattributes");
    git(cwd, "commit", "-m", "attributes");
    writeFileSync(join(cwd, "tracked.txt"), "modified\n");

    git(cwd, "config", "core.fsmonitor", command);
    tryGit(cwd, "status", "--porcelain=v1");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });

    git(cwd, "config", "diff.external", command);
    tryGit(cwd, "diff");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });

    git(cwd, "config", "--unset", "diff.external");
    git(cwd, "config", "diff.sentinel.textconv", command);
    tryGit(cwd, "diff", "--textconv");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });

    git(cwd, "config", "diff.external", command);
    git(cwd, "config", "core.pager", command);
    const trackedBefore = readFileSync(join(cwd, "tracked.txt"));
    const indexBefore = readFileSync(join(cwd, ".git", "index"));
    const previousPager = process.env.GIT_PAGER;
    process.env.GIT_PAGER = command;
    try {
      const tool = createGitInspectTool(cwd);
      await executeTool(tool, { action: "status" });
      await executeTool(tool, { action: "diff", scope: "worktree" });
    } finally {
      if (previousPager === undefined) delete process.env.GIT_PAGER;
      else process.env.GIT_PAGER = previousPager;
    }

    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(cwd, "tracked.txt"))).toEqual(trackedBefore);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(indexBefore);
  });

  it("hides repository content-filter commands from the main Git process", async () => {
    const cwd = createRepository();
    const { command, marker } = createSentinel(cwd);
    writeFileSync(join(cwd, ".gitattributes"), "tracked.txt filter=sentinel\n");
    git(cwd, "add", ".gitattributes");
    git(cwd, "commit", "-m", "content filter");
    git(cwd, "config", "filter.sentinel.clean", command);
    git(cwd, "config", "filter.sentinel.required", "true");
    writeFileSync(join(cwd, "tracked.txt"), "filtered worktree\n");

    tryGit(cwd, "diff");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
    const trackedBefore = readFileSync(join(cwd, "tracked.txt"));
    const indexBefore = readFileSync(join(cwd, ".git", "index"));
    const tool = createGitInspectTool(cwd);

    const status = await executeTool(tool, { action: "status" });
    const diff = await executeTool(tool, { action: "diff", scope: "all" });
    expect(status.details.stdout).toContain("tracked.txt");
    expect(diff.details.stdout).toContain("filtered worktree");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(cwd, "tracked.txt"))).toEqual(trackedBefore);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(indexBefore);
  });

  it("does not resolve a project-local fake Git executable", async () => {
    const cwd = createRepository();
    const fakeGit = join(cwd, process.platform === "win32" ? "git.exe" : "git");
    writeFileSync(fakeGit, "not an executable Git binary");
    if (process.platform !== "win32") chmodSync(fakeGit, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${cwd}${delimiter}${previousPath ?? ""}`;
    try {
      const result = await executeTool(createGitInspectTool(cwd), {
        action: "status",
      });
      expect(result.details.stdout).toContain("## main");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("does not start Git for a pre-aborted call and rejects mid-flight abort", async () => {
    const cwd = createRepository();
    const marker = join(cwd, "started");
    const script = `
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");
      setInterval(() => {}, 1000);
    `;
    const tool = nodeBackedTool(cwd, script);
    const preAborted = new AbortController();
    preAborted.abort();

    const preAbortError = await executeTool(
      tool,
      { action: "status" },
      preAborted.signal,
    ).catch((error: unknown) => error as Error);
    expect(preAbortError.name).toBe("AbortError");
    expect(existsSync(marker)).toBe(false);

    const runningAbort = new AbortController();
    const running = executeTool(tool, { action: "status" }, runningAbort.signal);
    for (let attempt = 0; attempt < 40 && !existsSync(marker); attempt++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(existsSync(marker)).toBe(true);
    runningAbort.abort();
    const runningError = await running.catch((error: unknown) => error as Error);
    expect(runningError.name).toBe("AbortError");
  });

  it("enforces one timeout across both all-scope Git processes", async () => {
    const cwd = createRepository();
    const script = "setTimeout(() => process.exit(0), 35);";
    const tool = nodeBackedTool(cwd, script, { timeoutMs: 55 });

    await expect(executeTool(tool, { action: "diff", scope: "all" }))
      .rejects.toThrow(/timed out/i);
  });

  it("shares byte and line limits across stdout, stderr, and all scope", async () => {
    const cwd = createRepository();
    const invocations = join(cwd, "invocations");
    const byteScript = `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(invocations)}, "x");
      process.stdout.write("o".repeat(13000));
      process.stderr.write("e".repeat(13000));
    `;
    const byteTool = nodeBackedTool(cwd, byteScript, {
      maxOutputBytes: 50 * 1024,
    });
    const bytes = await executeTool(byteTool, {
      action: "diff",
      scope: "all",
    });

    expect(bytes.details.truncated).toBe(true);
    expect(Buffer.byteLength(
      bytes.details.stdout + bytes.details.stderr,
      "utf8",
    )).toBeLessThanOrEqual(50 * 1024);
    expect(readFileSync(invocations, "utf8")).toBe("xx");

    const lineTool = nodeBackedTool(
      cwd,
      "process.stdout.write(Array(30).fill('line').join('\\n'));",
      { maxOutputLines: 10 },
    );
    const lines = await executeTool(lineTool, { action: "status" });
    expect(lines.details.truncated).toBe(true);
    expect(lines.details.stdout.split("\n").filter(Boolean)).toHaveLength(10);
  });

  it("returns a bounded error for a non-repository", async () => {
    const cwd = createRepository();
    rmSync(join(cwd, ".git"), { recursive: true, force: true });

    await expect(executeTool(createGitInspectTool(cwd), { action: "status" }))
      .rejects.toThrow(/not a git repository/i);
  });
});
