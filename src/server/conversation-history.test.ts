import type { AgentMessage } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_SNAPSHOT_BYTES,
  projectConversationHistory,
  projectConversationHistorySnapshot,
} from "./conversation-history.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

describe("projectConversationHistory", () => {
  it("groups one tool loop into the user and assistant bubbles shown by the live UI", () => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendMessage(message({
      role: "user",
      content: "inspect the project",
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should read it." },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
      ],
      usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6 },
      stopReason: "toolUse",
      timestamp: 2,
    }));
    manager.appendMessage(message({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "project readme" }],
      details: { lines: 1 },
      isError: false,
      timestamp: 3,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "The project is ready." }],
      usage: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 6 },
      stopReason: "stop",
      timestamp: 4,
    }));

    expect(projectConversationHistory(manager)).toEqual([
      expect.objectContaining({
        role: "user",
        text: "inspect the project",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "The project is ready.",
        thinking: "I should read it.",
        usage: { input: 5, output: 6, cacheRead: 1, cacheWrite: 0, total: 12 },
        tools: [{
          toolCallId: "tool-1",
          toolName: "read",
          args: { path: "README.md" },
          result: {
            content: [{ type: "text", text: "project readme" }],
            details: { lines: 1 },
          },
          status: "done",
        }],
      }),
    ]);
  });

  it("projects only the selected branch and preserves failed tool results", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const root = manager.appendMessage(message({
      role: "user",
      content: [{ type: "text", text: "root" }, { type: "image", data: "x", mimeType: "image/png" }],
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "abandoned" }],
      usage: { totalTokens: 1 },
      stopReason: "stop",
      timestamp: 2,
    }));
    manager.branch(root);
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "toolCall", id: "tool-error", name: "bash", arguments: { command: "exit 1" } }],
      usage: { totalTokens: 1 },
      stopReason: "toolUse",
      timestamp: 3,
    }));
    manager.appendMessage(message({
      role: "toolResult",
      toolCallId: "tool-error",
      toolName: "bash",
      content: [{ type: "text", text: "failed" }],
      isError: true,
      timestamp: 4,
    }));

    const history = projectConversationHistory(manager);
    expect(history[0]?.text).toBe("root\n[图片]");
    expect(history.some((item) => item.text === "abandoned")).toBe(false);
    expect(history[1]?.tools[0]).toMatchObject({
      toolCallId: "tool-error",
      status: "error",
    });
  });

  it("makes an SDK terminal error visible after restore", () => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendMessage(message({ role: "user", content: "fail", timestamp: 1 }));
    manager.appendMessage(message({
      role: "assistant",
      content: [],
      usage: { totalTokens: 0 },
      stopReason: "error",
      errorMessage: "provider unavailable",
      timestamp: 2,
    }));

    expect(projectConversationHistory(manager).at(-1)?.text).toBe(
      "运行失败：provider unavailable",
    );
  });

  it.each([
    {
      stopReason: "error",
      errorMessage: "provider unavailable",
      marker: "运行失败：provider unavailable",
    },
    {
      stopReason: "aborted",
      errorMessage: undefined,
      marker: "运行已中止。",
    },
  ] as const)("preserves partial text and the $stopReason terminal marker", ({
    stopReason,
    errorMessage,
    marker,
  }) => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendMessage(message({ role: "user", content: "start", timestamp: 1 }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
      usage: { totalTokens: 1 },
      stopReason,
      errorMessage,
      timestamp: 2,
    }));

    expect(projectConversationHistory(manager).at(-1)?.text).toBe(
      `partial answer\n\n${marker}`,
    );
  });

  it("bounds the browser snapshot while keeping the durable branch untouched", () => {
    const manager = SessionManager.inMemory("E:\\work");
    for (let index = 0; index < 12; index++) {
      manager.appendMessage(message({
        role: "user",
        content: `question-${index}-${"问".repeat(40_000)}`,
        timestamp: index * 2,
      }));
      manager.appendMessage(message({
        role: "assistant",
        content: [{ type: "text", text: `answer-${index}-${"答".repeat(40_000)}` }],
        usage: { totalTokens: 1 },
        stopReason: "stop",
        timestamp: index * 2 + 1,
      }));
    }

    const snapshot = projectConversationHistorySnapshot(manager);
    expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot.messages), "utf8"))
      .toBeLessThanOrEqual(MAX_HISTORY_SNAPSHOT_BYTES);
    expect(snapshot.messages.at(-1)?.text).toContain("answer-11");
    expect(projectConversationHistory(manager)).toHaveLength(24);
  });

  it("never starts a truncated snapshot with an orphaned assistant bubble", () => {
    const manager = SessionManager.inMemory("E:\\work");
    for (let index = 0; index < 8; index++) {
      manager.appendMessage(message({
        role: "user",
        content: `question-${index}-${"q".repeat(100_000)}`,
        timestamp: index * 2,
      }));
      manager.appendMessage(message({
        role: "assistant",
        content: [{ type: "text", text: `answer-${index}-${"a".repeat(100_000)}` }],
        usage: { totalTokens: 1 },
        stopReason: "stop",
        timestamp: index * 2 + 1,
      }));
    }

    const snapshot = projectConversationHistorySnapshot(manager);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.messages[0]?.role).toBe("user");
    expect(snapshot.messages.at(-1)?.text).toContain("answer-7");
  });
});
