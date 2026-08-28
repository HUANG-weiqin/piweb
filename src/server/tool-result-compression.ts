import { compressLineStream } from "@piweb/context-compressor";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type AfterToolCall = NonNullable<AgentSession["agent"]["afterToolCall"]>;
type ToolResultContent = Parameters<AfterToolCall>[0]["result"]["content"];
type CompressedToolName = "bash" | "grep";

const encoder = new TextEncoder();
const GREP_LINE = /^(.+?)([:-])(\d+)\2 (.*)$/;
const COMPRESSOR_MARKER = /^\[(?:file: .*|previous line repeated \d+ more times|\.\.\. omitted \d+ lines \.\.\.|duplicate of output line \d+)\]$/;

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function grepLine(line: string): { path: string; text: string } | undefined {
  const match = GREP_LINE.exec(line);
  if (!match) return undefined;
  return { path: match[1], text: `${match[3]}${match[2]} ${match[4]}` };
}

function foldGrepPaths(lines: string[]): string[] {
  const folded: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const first = grepLine(lines[index]);
    if (!first) {
      folded.push(lines[index]);
      index += 1;
      continue;
    }

    let next = index + 1;
    while (next < lines.length && grepLine(lines[next])?.path === first.path) {
      next += 1;
    }

    if (next - index === 1) {
      folded.push(lines[index]);
    } else {
      folded.push(`[file: ${first.path}]`);
      for (let lineIndex = index; lineIndex < next; lineIndex += 1) {
        folded.push(grepLine(lines[lineIndex])!.text);
      }
    }
    index = next;
  }

  return folded;
}

function referenceLongDuplicates(lines: string[]): string[] {
  const firstLineByText = new Map<string, number>();

  return lines.map((line, index) => {
    if (COMPRESSOR_MARKER.test(line) || utf8Bytes(line) < 64) {
      return line;
    }

    const firstLine = firstLineByText.get(line);
    if (firstLine === undefined) {
      firstLineByText.set(line, index + 1);
      return line;
    }
    return `[duplicate of output line ${firstLine}]`;
  });
}

/** Compresses one bash or grep text result without retaining state. */
export function compressToolResultText(toolName: CompressedToolName, input: string): string {
  try {
    const compressed = compressLineStream(input);
    const lines = compressed.split(/\r\n|\r|\n/);
    const pathFolded = toolName === "grep" ? foldGrepPaths(lines) : lines;
    const output = referenceLongDuplicates(pathFolded).join("\n");

    return utf8Bytes(output) * 10 <= utf8Bytes(input) * 9 ? output : input;
  } catch {
    return input;
  }
}

function compressToolResultContent(
  toolName: CompressedToolName,
  content: ToolResultContent,
): ToolResultContent {
  let projectedContent: ToolResultContent | undefined;

  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (part.type !== "text") continue;

    const text = compressToolResultText(toolName, part.text);
    if (text === part.text) continue;

    projectedContent ??= content.slice();
    projectedContent[index] = { ...part, text };
  }

  return projectedContent ?? content;
}

/**
 * Compresses selected finalized tool results before Pi emits and persists them.
 */
export function installToolResultCompression(session: AgentSession): void {
  const extensionAfterToolCall = session.agent.afterToolCall;
  session.agent.afterToolCall = async (context, signal) => {
    const extensionPatch = await extensionAfterToolCall?.(context, signal);
    if (context.toolCall.name !== "bash" && context.toolCall.name !== "grep") {
      return extensionPatch;
    }

    const content = extensionPatch?.content ?? context.result.content;
    const projectedContent = compressToolResultContent(context.toolCall.name, content);
    if (projectedContent === content) return extensionPatch;
    return { ...extensionPatch, content: projectedContent };
  };
}
