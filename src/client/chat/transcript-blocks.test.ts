import { describe, expect, it } from "vitest";
import type { ChatMessageItem } from "./reducer";
import { projectTranscriptBlocks } from "./transcript-blocks";

function assistant(
  id: string,
  runId: string,
  text: string,
  thinking: string,
  toolId: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number },
): ChatMessageItem {
  return {
    kind: "message",
    id,
    runId,
    role: "assistant",
    text,
    thinking,
    tools: [{ id: toolId, name: "read", status: "done" }],
    parts: [
      { kind: "thinking", text: thinking },
      { kind: "tool", toolId },
      { kind: "text", text },
    ],
    usage,
  };
}

describe("projectTranscriptBlocks", () => {
  it("merges adjacent assistant segments from one run while retaining a later run boundary", () => {
    const first = assistant("assistant-1", "run-1", "First answer.", "First thought.", "tool-1", {
      input: 3,
      output: 5,
      cacheRead: 7,
      cacheWrite: 11,
      total: 26,
    });
    const second = assistant("assistant-2", "run-1", "Second answer.", "Second thought.", "tool-2", {
      input: 13,
      output: 17,
      cacheRead: 19,
      cacheWrite: 23,
      total: 72,
    });
    const nextRun = assistant("assistant-3", "run-2", "Next answer.", "Next thought.", "tool-3", {
      input: 29,
      output: 31,
      cacheRead: 37,
      cacheWrite: 41,
      total: 138,
    });

    const blocks = projectTranscriptBlocks([first, second, nextRun]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      kind: "message",
      message: {
        id: "assistant-1",
        runId: "run-1",
        text: "First answer.\n\nSecond answer.",
        thinking: "First thought.\n\nSecond thought.",
        tools: [
          { id: "tool-1", name: "read", status: "done" },
          { id: "tool-2", name: "read", status: "done" },
        ],
        parts: [
          { kind: "thinking", text: "First thought." },
          { kind: "tool", toolId: "tool-1" },
          { kind: "text", text: "First answer." },
          { kind: "thinking", text: "Second thought." },
          { kind: "tool", toolId: "tool-2" },
          { kind: "text", text: "Second answer." },
        ],
        usage: {
          input: 16,
          output: 22,
          cacheRead: 26,
          cacheWrite: 34,
          total: 98,
        },
      },
    });
    expect(blocks[1]).toEqual({ kind: "message", message: nextRun });
  });
});
