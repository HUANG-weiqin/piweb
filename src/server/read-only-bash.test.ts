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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReadOnlyBashTool, isReviewedCommand } from "./read-only-bash.js";

/**
 * Real Git Bash spawns occasionally stall for seconds while the whole suite is
 * running in parallel; bound every spawn generously so only a genuine hang
 * fails. The tool's command timeout stays below the per-test ceiling so its own
 * error surfaces instead of vitest's.
 */
const SYNC_SPAWN_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_SECONDS = 30;
const TEST_TIMEOUT_MS = 60_000;

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
    timeout: SYNC_SPAWN_TIMEOUT_MS,
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
  const gitExecPath = execFileSync("git", ["--exec-path"], {
    encoding: "utf8",
    timeout: SYNC_SPAWN_TIMEOUT_MS,
  }).trim();
  const candidate = resolve(gitExecPath, "..", "..", "..", "usr", "bin", "bash.exe");
  return existsSync(candidate) ? candidate : undefined;
}

const TEST_BASH_PATH = findWindowsTestBash();

const sampledCommands = [
  "git status --short",
  "git cat-file -t HEAD",
  "git name-rev --name-only HEAD",
  "git config --local --list",
  "git --no-pager log --topo-order -1 | head -1",
  "rg -n 'initial|needle' .",
  "rg --files | head -5",
  "cd nested && rg needle .",
  "pwd&&cd nested&&pwd",
  "grep -n initial 'space name.txt'",
  "sort 'space name.txt' | uniq -c",
  "file --brief 'space name.txt'",
] as const;

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
  "tinyfish search query 'agentql pricing'",
  'tinyfish search query "agentql pricing" --pretty',
  "tinyfish search query pricing --location US --language en --include-domains example.com --exclude-domains other.example --page 1",
  "tinyfish search query --page=0 --location=US --language=en --include-domains=example.com --exclude-domains=other.example pricing",
  "tinyfish search query --pretty -- '--output is a search term'",
  "tinyfish search query 'auth login; $(touch marker)'",
  "tinyfish search query --help",
  "tinyfish fetch content get https://example.com",
  "tinyfish fetch content get https://example.com https://example.org --pretty",
  "tinyfish fetch content get 'https://example.com/?a=1&b=2' --format markdown --links --image-links --per-url-timeout-ms 15000",
  "tinyfish fetch content get https://example.com --format=html --per-url-timeout-ms=15000 --include-etag-and-last-modified",
  "tinyfish fetch content get https://example.com --if-none-match 'etag' --if-modified-since 'Wed, 21 Oct 2015 07:28:00 GMT'",
  "tinyfish fetch content get -h",
  "tinyfish fetch content get -- https://example.com",
  "tinyfish search query pricing | jq '.results' | head -5",
  "cd nested && tinyfish fetch content get https://example.com --format markdown",
  "tinyfish search query pricing && tinyfish fetch content get https://example.com",
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
  ["a bare TinyFish command", "tinyfish"],
  ["TinyFish authentication", "tinyfish auth login"],
  ["TinyFish credential modification", "tinyfish auth set"],
  ["TinyFish agent setup", "tinyfish connect --all"],
  ["TinyFish configuration", "tinyfish config claude"],
  ["TinyFish upgrades", "tinyfish upgrade"],
  ["TinyFish onboarding", "tinyfish onboard"],
  ["TinyFish diagnostics outside the query scope", "tinyfish doctor"],
  ["TinyFish automation", "tinyfish agent run 'Buy a product' --url https://example.com"],
  ["TinyFish browser creation", "tinyfish browser session create"],
  ["TinyFish vault modification", "tinyfish vault connection add --provider 1password"],
  ["TinyFish incomplete search", "tinyfish search"],
  ["TinyFish unknown search action", "tinyfish search update pricing"],
  ["TinyFish incomplete fetch", "tinyfish fetch content"],
  ["TinyFish unknown fetch action", "tinyfish fetch content delete https://example.com"],
  ["TinyFish unknown search option", "tinyfish search query pricing --output results.json"],
  ["TinyFish unknown fetch option", "tinyfish fetch content get https://example.com --output=page.md"],
  ["TinyFish abbreviated option", "tinyfish search query pricing --loc US"],
  ["TinyFish fetch-only option on search", "tinyfish search query pricing --format markdown"],
  ["TinyFish search-only option on fetch", "tinyfish fetch content get https://example.com --page 0"],
  ["TinyFish missing option value", "tinyfish search query pricing --location"],
  ["TinyFish empty option value", "tinyfish fetch content get https://example.com --format="],
  ["TinyFish option instead of a value", "tinyfish search query pricing --location --output=results.json"],
  ["TinyFish unreviewed global option", "tinyfish --debug search query pricing"],
  ["TinyFish option smuggling", "tinyfish search query pricing --location US -- auth login && tinyfish upgrade"],
  ["TinyFish via an installer", "npx @tiny-fish/cli search query pricing"],
  ["a TinyFish command path", "/usr/bin/tinyfish search query pricing"],
  ["TinyFish output redirection", "tinyfish fetch content get https://example.com > page.md"],
  ["TinyFish shell expansion", 'tinyfish search query "$(touch marker)"'],
  ["TinyFish unsafe pipeline", "tinyfish search query pricing | sh"],
] as const;

describe("createReadOnlyBashTool", { timeout: TEST_TIMEOUT_MS }, () => {
  let cwd: string;
  let tool: ReturnType<typeof createReadOnlyBashTool>;

  beforeAll(() => {
    cwd = createRepository();
    tool = createReadOnlyBashTool(cwd, TEST_BASH_PATH);
  }, TEST_TIMEOUT_MS);

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  }, TEST_TIMEOUT_MS);

  it.each(allowedCommands)("classifies the reviewed query as allowed: %s", (command) => {
    expect(isReviewedCommand(command)).toBe(true);
  });

  it.each(rejectedCommands)("classifies %s as rejected", (_label, command) => {
    expect(isReviewedCommand(command)).toBe(false);
  });

  it.each(sampledCommands)(
    "executes a sampled reviewed command end-to-end: %s",
    async (command) => {
      await expect(executeTool(tool, { command, timeout: COMMAND_TIMEOUT_SECONDS })).resolves.toBeDefined();
    },
  );

  it("reviews before calling injected operations and keeps spawn sanitation", async () => {
    const exec = vi.fn(async (
      _command: string,
      _cwd: string,
      options: { onData(data: Buffer): void; env?: NodeJS.ProcessEnv },
    ) => {
      options.onData(Buffer.from("reviewed query\n"));
      return { exitCode: 0 };
    });
    const tool = createReadOnlyBashTool(cwd, TEST_BASH_PATH, { exec });
    await expect(executeTool(tool, { command: "rm victim" }))
      .rejects.toThrow(/read-only/i);
    expect(exec).not.toHaveBeenCalled();
    expect(outputText(await executeTool(tool, { command: "pwd" })))
      .toContain("reviewed query");
    expect(exec).toHaveBeenCalledWith("pwd", cwd, expect.objectContaining({
      env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" }),
    }));
  });

  it("executes only the reviewed TinyFish queries through Pi Bash operations", async () => {
    const exec = vi.fn(async (
      _command: string,
      _cwd: string,
      options: { onData(data: Buffer): void },
    ) => {
      options.onData(Buffer.from('{"results":[],"errors":[]}\n'));
      return { exitCode: 0 };
    });
    const tool = createReadOnlyBashTool(cwd, TEST_BASH_PATH, { exec });
    for (const command of [
      "tinyfish auth login",
      "tinyfish agent run 'Buy a product' --url https://example.com",
      "tinyfish fetch content get https://example.com --output page.md",
      "tinyfish search query pricing | sh",
    ]) {
      await expect(executeTool(tool, { command })).rejects.toThrow(/not executed/i);
    }
    expect(exec).not.toHaveBeenCalled();

    for (const command of [
      "tinyfish search query 'agentql pricing' --pretty",
      "tinyfish fetch content get https://example.com --format markdown --per-url-timeout-ms 15000",
    ]) {
      expect(outputText(await executeTool(tool, { command }))).toContain('"errors":[]');
      expect(exec).toHaveBeenLastCalledWith(command, cwd, expect.any(Object));
    }
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("executes a real rg search with alternation", async () => {
    const result = await executeTool(tool, {
      command: "rg -n 'initial|needle' .",
      timeout: COMMAND_TIMEOUT_SECONDS,
    });

    expect(outputText(result)).toContain("initial content");
    expect(outputText(result)).toContain("nested needle");
  });

  it("supports call-scoped cd and a real query pipeline", async () => {
    const result = await executeTool(tool, {
      command: "cd nested && rg -n needle . | head -1",
      timeout: COMMAND_TIMEOUT_SECONDS,
    });

    expect(outputText(result)).toContain("needle.txt:1:nested needle");
  });

  it("supports a realistic Git query pipeline", async () => {
    const result = await executeTool(tool, {
      command: "git --no-pager log --format='%s' -1 | head -1",
      timeout: COMMAND_TIMEOUT_SECONDS,
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
      await executeTool(tool, { command: "pwd", timeout: COMMAND_TIMEOUT_SECONDS });
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
      const result = await executeTool(tool, { command: "pwd", timeout: COMMAND_TIMEOUT_SECONDS });
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
        timeout: COMMAND_TIMEOUT_SECONDS,
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
        timeout: COMMAND_TIMEOUT_SECONDS,
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
    expect(tool.description).not.toMatch(/run_in_background|bash_output|10 minutes|milliseconds/i);
    expect(JSON.stringify(tool.parameters)).toMatch(/timeout.{0,100}seconds/i);
    expect(tool.promptSnippet).toMatch(/Git, rg, and file queries/i);
    expect(tool.promptSnippet).toMatch(/TinyFish/i);
    expect(tool.promptGuidelines?.join(" ")).toContain("tinyfish search query");
    expect(tool.promptGuidelines?.join(" ")).toContain("tinyfish fetch content get");
    expect(tool.promptSnippet).not.toMatch(/run_in_background|bash_output/i);
    expect(tool.promptGuidelines?.join(" ")).not.toMatch(/run_in_background|bash_output/i);
    expect(tool.promptGuidelines).toEqual(expect.arrayContaining([
      expect.stringMatching(/cd.*do not persist/i),
      expect.stringMatching(/redirects.*rejected/i),
    ]));
  });
});
