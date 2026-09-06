import {
  createBashToolDefinition,
  defineTool,
  type BashSpawnContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const MAX_COMMAND_LENGTH = 4_096;
const SIMPLE_GIT_QUERY_PATTERN = /^(?:status|diff|diff-files|diff-index|diff-tree|log|show|shortlog|blame|grep|ls-files|ls-tree|cat-file|rev-parse|merge-base|name-rev|describe|for-each-ref|show-ref|version)$/u;
const FORBIDDEN_GIT_SHORT_ARGUMENT_PATTERN = /^-O.*$/u;
const FORBIDDEN_GIT_LONG_OPTIONS = [
  ["--config-env", "--config-e"],
  ["--paginate", "--pag"],
  ["--output", "--out"],
  ["--ext-diff", "--ext-d"],
  ["--textconv", "--t"],
  ["--filters", "--fi"],
  ["--open-files-in-pager", "--op"],
] as const;
const CONFIG_QUERY_PATTERN = /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/u;
const CONFIG_PREFIX_PATTERN = /^(?:--global|--system|--local|--worktree|--includes|--no-includes|--null|-z|--name-only|--show-origin|--show-scope|--fixed-value|--no-type|--(?:file|blob|type|default)=.+)$/u;
const CONFIG_WRITE_PATTERN = /^(?:--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|--edit|-e)(?:=.*)?$/u;
const GENERIC_QUERY_COMMAND_PATTERN = /^(?:ls|grep|cat|head|wc|cut|tr|jq|stat|du|df|readlink|realpath|dirname|basename)$/u;
const FIND_SIDE_EFFECT_PATTERN = /^-(?:delete|exec(?:dir)?|ok(?:dir)?|fprint(?:0|f)?|fls)$/u;
const RG_EXTERNAL_PROGRAM_PATTERN = /^--(?:pre(?:-glob)?|hostname-bin)(?:=.*)?$/u;
const SORT_SIDE_EFFECT_SHORT_PATTERN = /^-[^-]*[oT].*$/u;
const SORT_SIDE_EFFECT_LONG_OPTIONS = [
  ["--output", "--o"],
  ["--compress-program", "--co"],
  ["--temporary-directory", "--t"],
] as const;
const TAIL_FOLLOW_SHORT_PATTERN = /^(?:-[^-]*[fF].*|\+(?:[0-9]+)?(?:[bcl])?f)$/u;
const TAIL_FOLLOW_LONG_OPTIONS = [
  ["--follow", "--f"],
  ["--retry", "--r"],
  ["--pid", "--p"],
] as const;
const FILE_SIDE_EFFECT_SHORT_PATTERN = /^-[^-]*[zZC].*$/u;
const FILE_SIDE_EFFECT_LONG_OPTIONS = [
  ["--uncompress", "--u"],
  ["--uncompress-noreport", "--u"],
  ["--compile", "--co"],
] as const;
const UNIQ_FLAG_PATTERN = /^(?:-[cduiDz]+|-[fsw][0-9]+|--(?:count|repeated|unique|ignore-case|zero-terminated)|--(?:all-repeated|group)(?:=(?:none|prepend|separate|append|both))?|--(?:skip-fields|skip-chars|check-chars)=[0-9]+)$/u;
const UNIQ_VALUE_FLAG_PATTERN = /^-[fsw]$/u;

// Sticky atom patterns make the lexical scan anchored at the current position.
// Shell metacharacters are safe inside single quotes. Double quotes still exclude
// expansion and escape syntax, so review never has to emulate Bash expansion.
const BARE_ATOM_PATTERN = /[A-Za-z0-9_./:@%+,=~^-]+/y;
const SINGLE_QUOTED_ATOM_PATTERN = /'([^\x00-\x1f\x7f']*)'/y;
const DOUBLE_QUOTED_ATOM_PATTERN = /"([^\x00-\x1f\x7f"$\\`]*)"/y;

const REJECTION_MESSAGE =
  "Command was not executed: read-only Bash accepts reviewed Git/rg queries and pwd, ls, grep, find, cat, head, tail, wc, cut, tr, jq, sort, uniq, stat, du, df, readlink, realpath, dirname, basename, or file; each | or && segment is checked, cd only scopes the current call, and redirects, expansions, and modifying forms are rejected.";

interface ParsedSegment {
  words: string[];
  separator?: "|" | "&&";
}

function parseSafeSegments(command: string): ParsedSegment[] | undefined {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) return;

  const segments: ParsedSegment[] = [];
  let words: string[] = [];
  let index = 0;

  while (index < command.length) {
    while (command[index] === " " || command[index] === "\t") index++;
    if (index === command.length) break;

    const operator = command.startsWith("&&", index)
      ? "&&"
      : command[index] === "|" && command[index + 1] !== "|"
        ? "|"
        : undefined;
    if (operator) {
      if (words.length === 0) return;
      segments.push({ words, separator: operator });
      words = [];
      index += operator.length;
      continue;
    }
    if (command[index] === "&" || command[index] === "|") return;

    const rawStart = index;
    let word = "";
    while (
      index < command.length
      && command[index] !== " "
      && command[index] !== "\t"
      && command[index] !== "&"
      && command[index] !== "|"
    ) {
      const current = command[index];
      if (index === rawStart && current === "~") return;
      let pattern = BARE_ATOM_PATTERN;
      let quoted = false;
      if (current === "'") {
        pattern = SINGLE_QUOTED_ATOM_PATTERN;
        quoted = true;
      } else if (current === '"') {
        pattern = DOUBLE_QUOTED_ATOM_PATTERN;
        quoted = true;
      }
      pattern.lastIndex = index;
      const match = pattern.exec(command);
      if (!match) return;
      word += quoted ? match[1] : match[0];
      index = pattern.lastIndex;
    }

    if (words.length === 0 && command.slice(rawStart, index) !== word) return;
    words.push(word);
  }

  if (words.length === 0) return;
  segments.push({ words });
  return segments;
}

function hasOnlyPatterns(arguments_: readonly string[]): boolean {
  return arguments_.every((argument) => !argument.startsWith("-"));
}

function isReadOnlyGitShape(
  subcommand: string,
  arguments_: readonly string[],
): boolean {
  if (SIMPLE_GIT_QUERY_PATTERN.test(subcommand)) return true;

  switch (subcommand) {
    case "branch":
      return arguments_.length === 0
        || (arguments_.length === 1 && arguments_[0] === "--show-current")
        || ((arguments_[0] === "--list" || arguments_[0] === "-l")
          && hasOnlyPatterns(arguments_.slice(1)));
    case "tag":
      return arguments_.length === 0
        || ((arguments_[0] === "--list" || arguments_[0] === "-l")
          && hasOnlyPatterns(arguments_.slice(1)));
    case "remote": {
      if (arguments_.length === 0) return true;
      if (
        arguments_.length === 1
        && (arguments_[0] === "-v" || arguments_[0] === "--verbose")
      ) {
        return true;
      }
      if (arguments_[0] !== "get-url") return false;
      const remoteNames = arguments_.slice(1).filter(
        (argument) => argument !== "--all" && argument !== "--push",
      );
      return remoteNames.length === 1 && !remoteNames[0].startsWith("-");
    }
    case "stash":
      return arguments_[0] === "list" || arguments_[0] === "show";
    case "reflog":
      return arguments_[0] === "show";
    case "worktree":
      return arguments_[0] === "list";
    case "submodule":
      return arguments_[0] === "status" || arguments_[0] === "summary";
    case "config": {
      const queryIndex = arguments_.findIndex((argument) =>
        CONFIG_QUERY_PATTERN.test(argument)
      );
      return queryIndex !== -1
        && !arguments_.slice(queryIndex + 1).some(
          (argument) => CONFIG_QUERY_PATTERN.test(argument),
        )
        && arguments_.slice(0, queryIndex).every(
          (argument) => CONFIG_PREFIX_PATTERN.test(argument),
        )
        && !arguments_.some((argument) => CONFIG_WRITE_PATTERN.test(argument));
    }
    default:
      return false;
  }
}

type ForbiddenLongOption = readonly [option: string, minimumPrefix: string];

function matchesForbiddenLongOption(
  argument: string,
  options: readonly ForbiddenLongOption[],
): boolean {
  if (!argument.startsWith("--")) return false;
  const equals = argument.indexOf("=");
  const name = equals === -1 ? argument : argument.slice(0, equals);
  return options.some(([option, minimumPrefix]) =>
    name.length >= minimumPrefix.length && option.startsWith(name)
  );
}

function isReviewedGit(words: readonly string[]): boolean {
  let index = 1;
  while (index < words.length) {
    if (words[index] === "-C") {
      if (!words[index + 1]) return false;
      index += 2;
      continue;
    }
    if (words[index] === "--no-pager" || words[index] === "--no-optional-locks") {
      index++;
      continue;
    }
    break;
  }

  const subcommand = words[index];
  if (!subcommand || subcommand.startsWith("-")) return false;
  const arguments_ = words.slice(index + 1);
  return !arguments_.some((argument) =>
      FORBIDDEN_GIT_SHORT_ARGUMENT_PATTERN.test(argument)
      || matchesForbiddenLongOption(argument, FORBIDDEN_GIT_LONG_OPTIONS)
    )
    && isReadOnlyGitShape(subcommand, arguments_);
}

function hasForbiddenOption(
  arguments_: readonly string[],
  pattern: RegExp,
): boolean {
  const optionEnd = arguments_.indexOf("--");
  const options = optionEnd === -1 ? arguments_ : arguments_.slice(0, optionEnd);
  return options.some((argument) => pattern.test(argument));
}

function hasForbiddenLongOption(
  arguments_: readonly string[],
  options: readonly ForbiddenLongOption[],
): boolean {
  const optionEnd = arguments_.indexOf("--");
  const optionArguments = optionEnd === -1
    ? arguments_
    : arguments_.slice(0, optionEnd);
  return optionArguments.some((argument) =>
    matchesForbiddenLongOption(argument, options)
  );
}

function isReviewedUniq(arguments_: readonly string[]): boolean {
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (UNIQ_FLAG_PATTERN.test(argument)) continue;
    if (
      UNIQ_VALUE_FLAG_PATTERN.test(argument)
      && /^[0-9]+$/u.test(arguments_[index + 1] ?? "")
    ) {
      index++;
      continue;
    }
    return false;
  }
  return true;
}

function isReviewedSegment(segment: ParsedSegment): boolean {
  const [name, ...arguments_] = segment.words;
  switch (name) {
    case "cd":
      return segment.separator === "&&"
        && (arguments_.length === 1
          || (arguments_.length === 2 && arguments_[0] === "--"))
        && arguments_.at(-1) !== "";
    case "git":
      return isReviewedGit(segment.words);
    case "rg":
      return !hasForbiddenOption(arguments_, RG_EXTERNAL_PROGRAM_PATTERN);
    case "pwd":
      return arguments_.every((argument) => argument === "-L" || argument === "-P");
    case "find":
      return !arguments_.some((argument) => FIND_SIDE_EFFECT_PATTERN.test(argument));
    case "sort":
      return !hasForbiddenOption(arguments_, SORT_SIDE_EFFECT_SHORT_PATTERN)
        && !hasForbiddenLongOption(arguments_, SORT_SIDE_EFFECT_LONG_OPTIONS);
    case "uniq":
      return isReviewedUniq(arguments_);
    case "tail":
      return !hasForbiddenOption(arguments_, TAIL_FOLLOW_SHORT_PATTERN)
        && !hasForbiddenLongOption(arguments_, TAIL_FOLLOW_LONG_OPTIONS);
    case "file":
      return !hasForbiddenOption(arguments_, FILE_SIDE_EFFECT_SHORT_PATTERN)
        && !hasForbiddenLongOption(arguments_, FILE_SIDE_EFFECT_LONG_OPTIONS);
    default:
      return GENERIC_QUERY_COMMAND_PATTERN.test(name);
  }
}

function isReviewedCommand(command: string): boolean {
  const segments = parseSafeSegments(command);
  return segments !== undefined && segments.every(isReviewedSegment);
}

function sanitizeSpawnContext(context: BashSpawnContext): BashSpawnContext {
  const env = { ...context.env };
  const removedNames = new Set([
    "BASH_ENV",
    "BASHOPTS",
    "CDPATH",
    "ENV",
    "GIT_OPTIONAL_LOCKS",
    "GIT_PAGER",
    "PS4",
    "RIPGREP_CONFIG_PATH",
    "SHELLOPTS",
  ]);
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (removedNames.has(normalized) || normalized.startsWith("BASH_FUNC_")) {
      delete env[key];
    }
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  return { ...context, env };
}

export function createReadOnlyBashTool(
  cwd: string,
  shellPath?: string,
): ToolDefinition {
  const bash = createBashToolDefinition(cwd, {
    shellPath,
    spawnHook: sanitizeSpawnContext,
  });
  return defineTool({
    ...bash,
    description:
      "Execute a conservatively reviewed query shell command with Git, rg, and common file-inspection tools. Reviewed | and && chains are supported; cd affects only this call. This text guardrail is not an OS sandbox.",
    promptSnippet:
      "Run reviewed Git, rg, and file queries with safe pipes, &&, and call-scoped cd.",
    promptGuidelines: [
      "Use `cd <dir> && <query>` when needed; directory changes do not persist across bash calls.",
      "Redirects, shell expansion, unlisted programs, and modifying command forms are rejected; use the builtin read/grep/find/ls tools when they fit better.",
    ],
    async execute(toolCallId, input, signal, onUpdate, context) {
      if (!isReviewedCommand(input.command)) {
        throw new Error(REJECTION_MESSAGE);
      }
      return bash.execute(toolCallId, input, signal, onUpdate, context);
    },
  });
}
