import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadOnlyBashTool } from "./read-only-bash.js";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

type ToolUpdate = Parameters<ToolDefinition["execute"]>[3];

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "piweb-read-only-bash-"));
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.email", "piweb@example.invalid");
  git(cwd, "config", "user.name", "Pi Web Test");
  git(cwd, "config", "http.https://example.invalid.sslVerify", "true");
  mkdirSync(join(cwd, "nested"));
  writeFileSync(join(cwd, "space name.txt"), "initial content\n");
  writeFileSync(join(cwd, "nested", "needle.txt"), "nested needle\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial commit");
  git(cwd, "tag", "v1");
  git(cwd, "remote", "add", "origin", "https://example.invalid/repo.git");
  writeFileSync(join(cwd, "space name.txt"), "stashed content\n");
  git(cwd, "stash", "push", "-m", "fixture");
  return cwd;
}

function executeTool(
  tool: ToolDefinition,
  input: { command: string; timeout?: number },
  signal?: AbortSignal,
  onUpdate?: ToolUpdate,
): Promise<ToolResult> {
  return tool.execute(
    "tool-call",
    input as never,
    signal,
    onUpdate,
    undefined as never,
  ) as Promise<ToolResult>;
}

function outputText(result: ToolResult): string {
  return result.content.map(({ text }) => text ?? "").join("\n");
}

function shellPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function findWindowsTestBash(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const candidate = resolve(gitExecPath, "..", "..", "..", "usr", "bin", "bash.exe");
  return existsSync(candidate) ? candidate : undefined;
}

const TEST_BASH_PATH = findWindowsTestBash();

const allowedCommands = [
  "git status --short",
  "git diff -- 'space name.txt'",
  "git diff-files --",
  "git diff-index HEAD --",
  "git diff-tree --root HEAD",
  "git log -1 --format='%h %s'",
  'git log -1 --format="%h %s"',
  "git show --stat HEAD",
  "git shortlog -s -n HEAD",
  "git blame -- 'space name.txt'",
  "git grep --only-matching initial -- 'space name.txt'",
  "git ls-files",
  "git ls-tree HEAD",
  "git cat-file -t HEAD",
  "git rev-parse --show-toplevel",
  "git merge-base HEAD HEAD",
  "git name-rev --name-only HEAD",
  "git describe --always HEAD",
  "git for-each-ref --format='%(refname:short)'",
  "git show-ref",
  "git version",
  "git branch",
  "git branch --show-current",
  "git branch --list 'ma*'",
  "git tag",
  "git tag --list 'v*'",
  "git remote",
  "git remote -v",
  "git remote get-url origin",
  "git stash list",
  "git stash show",
  "git reflog show -1",
  "git worktree list --porcelain",
  "git submodule status",
  "git submodule summary",
  "git config --get user.name",
  "git config --get-all user.name",
  "git config --get-regexp '^user[.]'",
  "git config --get-urlmatch http.sslVerify https://example.invalid",
  "git config --list",
  "git config --local --list",
  "git config -l",
  "git --no-pager log --topo-order -1 | head -1",
  "git -C . --no-optional-locks status --short",
  "rg -n 'initial|needle' .",
  'rg -n "initial|needle" .',
  "rg --files | head -5",
  "cd nested && rg needle .",
  "pwd&&cd nested&&pwd",
  "pwd -P",
  "ls -la",
  "grep -n initial 'space name.txt'",
  "find . -maxdepth 2 -type f | wc -l",
  "cat 'space name.txt' | head -n 1",
  "tail --quiet -n 1 'space name.txt'",
  "wc -l 'space name.txt'",
  "cut -c 1-7 'space name.txt'",
  "tr a-z A-Z",
  "sort --check=silent 'space name.txt'",
  "sort 'space name.txt' | uniq -c",
  "stat 'space name.txt'",
  "du -sh .",
  "df .",
  "readlink -f 'space name.txt'",
  "realpath 'space name.txt'",
  "dirname nested/needle.txt",
  "basename nested/needle.txt",
  "file --brief 'space name.txt'",
  "rg 'initial|needle;and$(text)&<>`' .",
] as const;

const rejectedCommands = [
  ["empty input", ""],
  ["whitespace only", "   \t"],
  ["a non-query command", "node --version"],
  ["a command path", "/usr/bin/rg needle ."],
  ["a quoted command name", "r'g' needle ."],
  ["an environment assignment", "PAGER=cat git log"],
  ["multiple lines", "git status\ngit log"],
  ["a semicolon", "git status; git log"],
  ["an OR chain", "rg needle . || pwd"],
  ["a background ampersand", "rg needle . & pwd"],
  ["a redirect", "git diff > patch"],
  ["an input redirect", "wc -l < file"],
  ["unquoted command substitution", "rg $(touch marker) ."],
  ["double-quoted command substitution", 'rg "$(touch marker)" .'],
  ["unquoted backtick substitution", "rg `touch marker` ."],
  ["double-quoted dollar expansion", 'rg "$HOME" .'],
  ["a bare home expansion", "cd ~ && pwd"],
  ["a home-directory expansion", "cd ~/nested && pwd"],
  ["a named-home expansion", "rg ~other ."],
  ["a backslash escape", String.raw`rg needle\ pattern .`],
  ["a process substitution", "cat <(git status)"],
  ["an unsafe pipeline segment", "rg needle . | sh"],
  ["a trailing pipeline", "rg needle . |"],
  ["standalone cd", "cd nested"],
  ["cd in a pipeline", "cd nested | pwd"],
  ["cd without a path", "cd && pwd"],
  ["cd with two paths", "cd one two && pwd"],
  ["an unreviewed Git subcommand", "git reset --hard"],
  ["Git config injection", "git -c color.ui=false status"],
  ["Git config environment injection", "git --config-env=key=ENV status"],
  ["forced pagination", "git --paginate log"],
  ["an output file", "git diff --output=patch"],
  ["an external diff", "git diff --ext-diff"],
  ["a textconv filter", "git diff --textconv"],
  ["a cat-file filter", "git cat-file --filters HEAD:filtered.txt"],
  ["an abbreviated cat-file filter", "git cat-file --fi HEAD:filtered.txt"],
  ["an abbreviated textconv filter", "git cat-file --t HEAD:filtered.txt"],
  ["an abbreviated external diff", "git diff --ext-d"],
  ["an editor pager", "git grep --open-files-in-pager term"],
  ["an abbreviated editor pager", "git grep --op=rm term"],
  ["the short editor pager option", "git grep -O term"],
  ["branch creation", "git branch new-branch"],
  ["branch deletion", "git branch -D main"],
  ["tag creation", "git tag v2"],
  ["remote mutation", "git remote add other https://example.invalid"],
  ["stash mutation", "git stash push"],
  ["reflog expiry", "git reflog expire --all"],
  ["worktree mutation", "git worktree add ../other"],
  ["submodule mutation", "git submodule update --init"],
  ["config mutation", "git config user.name changed"],
  ["a query flag used as a config value", "git config user.name --get"],
  ["a mixed config query and mutation", "git config --get user.name --unset user.name"],
  ["an rg preprocessor", "rg --pre=cat needle ."],
  ["an rg preprocessor glob", "rg --pre-glob='*.txt' needle ."],
  ["an rg hostname program", "rg --json --hostname-bin=touch needle ."],
  ["find deletion", "find . -delete"],
  ["find execution", "find . -exec touch marker"],
  ["find directory execution", "find . -execdir touch marker"],
  ["find confirmation execution", "find . -ok touch marker"],
  ["find file output", "find . -fprint marker"],
  ["find formatted file output", "find . -fprintf marker '%p'"],
  ["find ls file output", "find . -fls marker"],
  ["sort short output", "sort input -o marker"],
  ["sort attached output", "sort input -omarker"],
  ["sort long output", "sort input --output=marker"],
  ["sort abbreviated output", "sort input --o=marker"],
  ["sort compressor execution", "sort --compress-program=touch input"],
  ["sort abbreviated compressor", "sort --co=touch input"],
  ["sort temporary directory", "sort --temporary-directory=. input"],
  ["sort abbreviated temporary directory", "sort --t=. input"],
  ["sort short temporary directory", "sort -T. input"],
  ["uniq input/output operands", "uniq input marker"],
  ["tail follow", "tail -f file"],
  ["tail retry follow", "tail -F file"],
  ["tail long follow", "tail --follow=name file"],
  ["tail retry", "tail --retry file"],
  ["tail abbreviated follow", "tail --f=name file"],
  ["tail abbreviated retry", "tail --r file"],
  ["tail legacy follow", "tail +1f file"],
  ["tail legacy follow without a count", "tail +f file"],
  ["file decompression", "file -z archive.gz"],
  ["file long decompression", "file --uncompress archive.gz"],
  ["file abbreviated decompression", "file --uncompress-n archive.gz"],
  ["file magic compilation", "file -C -m magic"],
  ["file abbreviated magic compilation", "file --co -m magic"],
  ["an overlong command", `rg '${"a".repeat(4_096)}'`],
] as const;

describe("createReadOnlyBashTool", () => {
  let cwd: string;
  let tool: ReturnType<typeof createReadOnlyBashTool>;

  beforeAll(() => {
    cwd = createRepository();
    tool = createReadOnlyBashTool(cwd, TEST_BASH_PATH);
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each(allowedCommands)("allows the reviewed query workflow: %s", async (command) => {
    await expect(executeTool(tool, { command, timeout: 5 })).resolves.toBeDefined();
  });

  it.each(rejectedCommands)("rejects %s", async (_label, command) => {
    await expect(executeTool(tool, { command }))
      .rejects.toThrow(/Command was not executed.*accepts reviewed Git\/rg queries/i);
  });

  it("executes a real rg search with alternation", async () => {
    const result = await executeTool(tool, {
      command: "rg -n 'initial|needle' .",
      timeout: 5,
    });

    expect(outputText(result)).toContain("initial content");
    expect(outputText(result)).toContain("nested needle");
  });

  it("supports call-scoped cd and a real query pipeline", async () => {
    const result = await executeTool(tool, {
      command: "cd nested && rg -n needle . | head -1",
      timeout: 5,
    });

    expect(outputText(result)).toContain("needle.txt:1:nested needle");
  });

  it("supports a realistic Git query pipeline", async () => {
    const result = await executeTool(tool, {
      command: "git --no-pager log --format='%s' -1 | head -1",
      timeout: 5,
    });

    expect(outputText(result)).toContain("initial commit");
  });

  it("blocks modifying forms and option abbreviations before files change", async () => {
    const source = join(cwd, "must-survive.txt");
    const pagerVictim = join(cwd, "pager-victim.txt");
    const magic = join(cwd, "piweb-test.magic");
    const markers = [
      "rg-pre-marker",
      "rg-hostname-marker",
      "sort-marker",
      "uniq-marker",
      "git-filter-marker",
      "piweb-test.magic.mgc",
    ].map((name) => join(cwd, name));
    writeFileSync(source, "survive\n");
    writeFileSync(pagerVictim, "pager-deletion-needle\n");
    writeFileSync(magic, "0 string PIWEB piweb marker\n");
    writeFileSync(join(cwd, ".gitattributes"), "filtered.txt filter=piweb-marker\n");
    writeFileSync(join(cwd, "filtered.txt"), "filtered\n");
    git(cwd, "config", "filter.piweb-marker.smudge", "sh -c 'printf injected > git-filter-marker; cat'");
    git(cwd, "add", ".gitattributes", "filtered.txt", "pager-victim.txt");
    git(cwd, "commit", "-m", "side-effect fixtures");

    const commands = [
      "rg --pre='sh -c touch rg-pre-marker' survive .",
      "rg --json --hostname-bin='sh -c touch rg-hostname-marker' survive .",
      "find . -delete",
      "sort must-survive.txt --o=sort-marker",
      "uniq must-survive.txt uniq-marker",
      "file --co -m piweb-test.magic",
      "git cat-file --fi HEAD:filtered.txt",
      "git grep --op=rm pager-deletion-needle",
    ];
    for (const command of commands) {
      await expect(executeTool(tool, { command })).rejects.toThrow(/not executed/i);
    }

    expect(existsSync(source)).toBe(true);
    expect(existsSync(pagerVictim)).toBe(true);
    expect(markers.every((marker) => !existsSync(marker))).toBe(true);
  });

  it("removes BASH_ENV before Pi Bash starts", async () => {
    const startup = join(cwd, "malicious-startup.sh");
    const marker = join(cwd, "bash-env-marker");
    writeFileSync(startup, "printf injected > bash-env-marker\n");
    const previous = process.env.BASH_ENV;
    process.env.BASH_ENV = shellPath(startup);
    try {
      await executeTool(tool, { command: "pwd", timeout: 5 });
    } finally {
      if (previous === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = previous;
    }

    expect(existsSync(marker)).toBe(false);
  });

  it("removes exported Bash functions that could shadow allowed names", async () => {
    const marker = join(cwd, "bash-function-marker");
    const key = "BASH_FUNC_pwd%%";
    const previous = process.env[key];
    process.env[key] = "() { printf injected > bash-function-marker; }";
    try {
      const result = await executeTool(tool, { command: "pwd", timeout: 5 });
      expect(outputText(result)).toMatch(/piweb-read-only-bash-/u);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }

    expect(existsSync(marker)).toBe(false);
  });

  it("ignores RIPGREP_CONFIG_PATH preprocessors", async () => {
    const config = join(cwd, "malicious-rg.conf");
    writeFileSync(config, "--pre=definitely-missing-piweb-preprocessor\n");
    const previous = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = shellPath(config);
    try {
      const result = await executeTool(tool, {
        command: "rg initial 'space name.txt'",
        timeout: 5,
      });
      expect(outputText(result)).toContain("initial content");
    } finally {
      if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = previous;
    }
  });

  it("delegates output, updates, timeout input, and AbortSignal to Pi Bash", async () => {
    const updates: unknown[] = [];
    const result = await executeTool(
      tool,
      {
        command: "git log --format='%s' -1 -- 'space name.txt'",
        timeout: 5,
      },
      new AbortController().signal,
      (update) => updates.push(update),
    );

    expect(outputText(result)).toContain("initial commit");
    expect(updates.length).toBeGreaterThan(0);

    const controller = new AbortController();
    controller.abort();
    await expect(executeTool(tool, { command: "git status" }, controller.signal))
      .rejects.toThrow(/aborted/i);
  });

  it("keeps Pi Bash's name and parameter schema while replacing its prompt", () => {
    const piBash = createBashToolDefinition(cwd);

    expect(tool.name).toBe("bash");
    expect(tool.parameters).toBe(piBash.parameters);
    expect(tool.description).toMatch(/reviewed query shell.*Git, rg/i);
    expect(tool.description).toMatch(/not an OS sandbox/i);
    expect(tool.promptSnippet).toMatch(/Git, rg, and file queries/i);
    expect(tool.promptGuidelines).toEqual(expect.arrayContaining([
      expect.stringMatching(/cd.*do not persist/i),
      expect.stringMatching(/redirects.*rejected/i),
    ]));
  });
});
