import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { MAX_MODEL_REFERENCE_BYTES } from "../shared/protocol.js";
import { COMPACTION_PROVENANCE_NAMESPACE } from "./compaction-provenance.js";
import {
  MAX_AGENT_PEEK_BYTES,
  MAX_AGENT_PEEK_ITEMS,
  MAX_HISTORY_SNAPSHOT_BYTES,
  projectAgentConversationPeek,
  projectConversationItems,
  projectConversationItemsSnapshot,
  projectConversationHistory,
  snapshotConversationItems,
} from "./conversation-history.js";
import {
  appendReservedCustomEntry,
  createCompactionResumeEntry,
  createConversationCardEntry,
  createConversationMessageEntry,
  createConversationMetaEntry,
  createEditBudgetEntry,
  createRunSettlementEntry,
} from "./conversation-meta.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}


function peer(conversationId = randomUUID()) {
  return {
    conversationId,
    title: "Worker",
    role: {
      id: "default",
      name: "Worker",
    },
  };
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
        parts: [{ kind: "text", offset: 0, length: 19 }],
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
        parts: [
          { kind: "thinking", offset: 0, length: 17 },
          { kind: "tool", toolCallId: "tool-1" },
          { kind: "text", offset: 0, length: 21 },
        ],
      }),
    ]);
  });

  it("uses settlement boundaries to identify restored runs", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const runId = randomUUID();
    const nextRunId = randomUUID();
    appendReservedCustomEntry(manager, createConversationMetaEntry({
      role: {
        id: "default",
        revision: 1,
        name: "Agent",
        description: "",
        systemPrompt: "",
        model: { provider: "openai", id: "gpt-5.6" },
        compactionModel: null,
        defaultThinkingLevel: "off",
        defaultServiceTier: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
      lifecycle: { kind: "normal" },
      createdBy: { kind: "user" },
    }));
    manager.appendMessage(message({
      role: "user",
      content: "first prompt",
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "legacy answer" }],
      stopReason: "stop",
      timestamp: 2,
    }));
    manager.appendMessage(message({
      role: "user",
      content: "request an edit budget",
      timestamp: 3,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "read-call",
        name: "read",
        arguments: { path: "README.md" },
      }],
      stopReason: "toolUse",
      timestamp: 4,
    }));
    manager.appendMessage(message({
      role: "toolResult",
      toolCallId: "read-call",
      toolName: "read",
      content: [{ type: "text", text: "project readme" }],
      isError: false,
      timestamp: 5,
    }));
    manager.appendMessage(message({
      role: "user",
      content: "also update the restored view",
      timestamp: 6,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: 7,
    }));
    const settlement = createRunSettlementEntry({
      runId,
      outcome: "completed",
      finalText: "done",
      settledAt: "2026-08-30T03:00:00.000Z",
    });
    appendReservedCustomEntry(manager, settlement);
    manager.appendMessage(message({
      role: "user",
      content: "start another run",
      timestamp: 8,
    }));
    appendReservedCustomEntry(manager, settlement);
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "second answer" }],
      stopReason: "stop",
      timestamp: 9,
    }));
    appendReservedCustomEntry(manager, createRunSettlementEntry({
      runId: nextRunId,
      outcome: "completed",
      finalText: "second answer",
      settledAt: "2026-08-30T03:01:00.000Z",
    }));
    manager.appendMessage(message({
      role: "user",
      content: "start a third run",
      timestamp: 10,
    }));

    const history = projectConversationHistory(manager);
    expect(history.slice(0, 6).map(({ runId: projectedRunId }) => projectedRunId))
      .toEqual([runId, runId, runId, runId, runId, runId]);
    expect(history.slice(6, 8).map(({ runId: projectedRunId }) => projectedRunId))
      .toEqual([nextRunId, nextRunId]);
    expect(history.at(-1)).not.toHaveProperty("runId");
  });

  it("keeps edit-budget facts when an oversized tool result is omitted", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const budget = {
      countedNewFile: true,
      grantedFiles: 2,
      touchedFiles: 1,
      remainingFiles: 1,
      blockedAttempts: 0,
    };
    manager.appendMessage(message({
      role: "user",
      content: "edit the large file",
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "edit-call",
        name: "edit",
        arguments: { path: "large.ts" },
      }],
      stopReason: "toolUse",
      timestamp: 2,
    }));
    manager.appendMessage(message({
      role: "toolResult",
      toolCallId: "edit-call",
      toolName: "edit",
      content: [{ type: "text", text: "x".repeat(9_000) }],
      details: { piwebEditBudget: budget },
      isError: false,
      timestamp: 3,
    }));
    for (let index = 0; index < 17; index += 1) {
      const toolCallId = `later-call-${index}`;
      manager.appendMessage(message({
        role: "assistant",
        content: [
          { type: "thinking", thinking: `thought-${index}-${"\u0000".repeat(10_000)}` },
          { type: "text", text: `chunk-${index}-${"\u0000".repeat(10_000)}` },
          {
            type: "toolCall",
            id: toolCallId,
            name: "read",
            arguments: { path: `file-${index}.ts` },
          },
        ],
        stopReason: "toolUse",
        timestamp: 4 + index * 2,
      }));
      manager.appendMessage(message({
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 5 + index * 2,
      }));
    }

    const snapshot = projectConversationItemsSnapshot(manager);
    const assistant = snapshot.items.at(-1);
    expect(assistant).toMatchObject({ kind: "message" });
    if (assistant?.kind !== "message") throw new Error("expected message item");
    expect(snapshot.window.contentTruncated).toBe(true);
    expect(assistant.tools.find((tool) => tool.toolCallId === "edit-call")?.result)
      .toEqual({
        content: "[历史工具数据过大，已省略]",
        details: { piwebEditBudget: budget },
      });
    expect(assistant.parts.at(-1)).toMatchObject({ kind: "tool" });
    expect(assistant.parts.some(
      (part) => part.kind === "tool" && part.toolCallId === "edit-call",
    )).toBe(false);
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

  it("restores an unfinished committed wait as pending with its declaration", () => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendMessage(message({
      role: "user",
      content: "delegate and wait",
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "wait-call",
        name: "wait_for_session",
        arguments: {
          targets: [{ conversationId: "peer", runId: "peer-run" }],
        },
      }],
      stopReason: "toolUse",
      timestamp: 2,
    }));

    expect(projectConversationHistory(manager).at(-1)?.tools).toEqual([{
      toolCallId: "wait-call",
      toolName: "wait_for_session",
      args: {
        targets: [{ conversationId: "peer", runId: "peer-run" }],
      },
      status: "pending",
    }]);
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

    const snapshot = projectConversationItemsSnapshot(manager);
    expect(snapshot.window).toEqual({
      omittedBefore: true,
      startsMidTurn: false,
      contentTruncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(snapshot.items), "utf8"))
      .toBeLessThanOrEqual(MAX_HISTORY_SNAPSHOT_BYTES);
    expect(snapshot.items.at(-1)).toMatchObject({
      kind: "message",
      text: expect.stringContaining("answer-11"),
    });
    expect(projectConversationHistory(manager)).toHaveLength(24);
  });

  it("keeps the newest visible item when one direct snapshot turn exceeds its page budget", () => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendMessage(message({
      role: "user",
      content: "start the oversized turn",
      timestamp: 1,
    }));
    for (let index = 0; index < 11; index += 1) {
      appendReservedCustomEntry(manager, createConversationCardEntry({
        cardId: randomUUID(),
        kind: "message",
        body: `card-${index}-${"x".repeat(70_000)}`,
        fromSnapshot: peer(),
        toSnapshot: peer(),
        state: "queued",
        messageId: randomUUID(),
        updatedAt: "2026-07-31T10:00:00.000Z",
      }));
    }

    const snapshot = projectConversationItemsSnapshot(manager);
    expect(snapshot.items).not.toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(snapshot.items), "utf8"))
      .toBeLessThanOrEqual(MAX_HISTORY_SNAPSHOT_BYTES);
    expect(snapshot.items.at(-1)).toMatchObject({
      kind: "session_message",
      body: expect.stringContaining("card-10-"),
    });
    expect(snapshot.window).toEqual({
      omittedBefore: true,
      startsMidTurn: true,
      contentTruncated: false,
    });
  });

  it("uses exact JSON bytes when an escaped newest item exceeds the page budget", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const bodyPrefix = "latest escaped body ";
    const resultPrefix = "latest escaped result ";
    const body = bodyPrefix + "\u0000".repeat(80_000 - bodyPrefix.length);
    const result = resultPrefix + "\u0000".repeat(80_000 - resultPrefix.length);
    appendReservedCustomEntry(manager, createConversationCardEntry({
      cardId: randomUUID(),
      kind: "message",
      body,
      fromSnapshot: peer(),
      toSnapshot: peer(),
      state: "completed",
      messageId: randomUUID(),
      result,
      updatedAt: "2026-07-31T10:00:00.000Z",
    }));

    const source = projectConversationItems(manager);
    expect(Buffer.byteLength(JSON.stringify(source), "utf8"))
      .toBeGreaterThan(MAX_HISTORY_SNAPSHOT_BYTES);
    const snapshot = projectConversationItemsSnapshot(manager);
    expect(snapshot.items).not.toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(snapshot.items), "utf8"))
      .toBeLessThanOrEqual(MAX_HISTORY_SNAPSHOT_BYTES);
    expect(snapshot.items.at(-1)).toMatchObject({
      kind: "session_message",
      body: expect.stringContaining(bodyPrefix),
      result: expect.stringContaining(resultPrefix),
    });
    expect(snapshot.window).toEqual({
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: true,
    });
  });

  it("keeps only the newest sixteen small tool calls in one timeline snapshot", () => {
    const tools = Array.from({ length: 25 }, (_, index) => ({
      toolCallId: `tool-${index}`,
      toolName: "read",
      args: { path: `src/file-${index}.ts` },
      result: { ok: true },
      status: "done" as const,
    }));
    const snapshot = snapshotConversationItems([{
      kind: "message",
      id: "assistant-many-tools",
      role: "assistant",
      text: "",
      thinking: "",
      tools,
      parts: tools.map((tool) => ({
        kind: "tool" as const,
        toolCallId: tool.toolCallId,
      })),
    }]);
    const assistant = snapshot.items[0];

    expect(assistant).toMatchObject({
      kind: "message",
      tools: tools.slice(-16).map((tool) => expect.objectContaining({
        toolCallId: tool.toolCallId,
      })),
      parts: tools.slice(-16).map((tool) => ({
        kind: "tool",
        toolCallId: tool.toolCallId,
      })),
    });
    expect(snapshot.window.contentTruncated).toBe(true);
  });

  it("retains the latest budget grant as a hidden timeline fact", () => {
    const budgetTool = {
      toolCallId: "budget-call",
      toolName: "request_edit_budget",
      args: { fileCount: 2, reason: "expand the proven scope" },
      result: { details: { remainingFiles: 3 } },
      status: "done" as const,
    };
    const laterTools = Array.from({ length: 17 }, (_, index) => ({
      toolCallId: `later-${index}`,
      toolName: "read",
      result: { ok: true },
      status: "done" as const,
    }));
    const tools = [budgetTool, ...laterTools];
    const snapshot = snapshotConversationItems([{
      kind: "message",
      id: "assistant-hidden-budget",
      runId: "run-1",
      role: "assistant",
      text: "",
      thinking: "",
      tools,
      parts: tools.map((tool) => ({
        kind: "tool" as const,
        toolCallId: tool.toolCallId,
      })),
    }]);
    const assistant = snapshot.items[0];

    expect(assistant).toMatchObject({ kind: "message" });
    if (assistant.kind !== "message") throw new Error("expected message item");
    expect(assistant.tools.find((tool) => tool.toolCallId === "budget-call")?.result)
      .toEqual({ details: { remainingFiles: 3 } });
    expect(assistant.parts?.some(
      (part) => part.kind === "tool" && part.toolCallId === "budget-call",
    )).toBe(false);
  });

  it("never emits more than sixteen parts when an oversized timeline is compacted", () => {
    const tools = Array.from({ length: 250 }, (_, index) => ({
      toolCallId: `tool-${index}`,
      toolName: "read",
      args: { path: `src/file-${index}.ts` },
      result: { ok: true },
      status: "done" as const,
    }));
    const snapshot = snapshotConversationItems([{
      kind: "message",
      id: "assistant-overflow-tools",
      role: "assistant",
      text: "done",
      thinking: "thinking",
      tools,
      parts: tools.map((tool) => ({
        kind: "tool" as const,
        toolCallId: tool.toolCallId,
      })),
    }]);
    const assistant = snapshot.items[0];
    expect(assistant).toMatchObject({ kind: "message" });
    if (assistant.kind !== "message") throw new Error("expected message item");
    expect(assistant.parts?.length ?? 0).toBeLessThanOrEqual(16);
    expect(snapshot.window.contentTruncated).toBe(true);
  });

  it("keeps a snapshot renderable when a compaction identity exceeds the page budget", () => {
    const snapshot = snapshotConversationItems([{
      kind: "compaction",
      id: "c".repeat(MAX_HISTORY_SNAPSHOT_BYTES),
      timestamp: "2026-07-31T10:00:00.000Z",
      tokensBefore: 42,
    }]);

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      kind: "compaction",
      id: expect.stringMatching(/…$/),
    });
    expect(Buffer.byteLength(JSON.stringify(snapshot.items), "utf8"))
      .toBeLessThanOrEqual(MAX_HISTORY_SNAPSHOT_BYTES);
    expect(snapshot.window).toEqual({
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: true,
    });
  });

  it("never starts a truncated snapshot with an orphaned assistant bubble", () => {
    const manager = SessionManager.inMemory("E:\\work");
    for (let index = 0; index < 8; index++) {
      manager.appendMessage(message({
        role: "user",
        content: `question-${index}-${"q".repeat(60_000)}`,
        timestamp: index * 2,
      }));
      manager.appendMessage(message({
        role: "assistant",
        content: [{ type: "text", text: `answer-${index}-${"a".repeat(60_000)}` }],
        usage: { totalTokens: 1 },
        stopReason: "stop",
        timestamp: index * 2 + 1,
      }));
    }

    const snapshot = projectConversationItemsSnapshot(manager);
    expect(snapshot.window).toEqual({
      omittedBefore: true,
      startsMidTurn: false,
      contentTruncated: false,
    });
    expect(snapshot.items[0]).toMatchObject({ kind: "message", role: "user" });
    expect(snapshot.items.at(-1)).toMatchObject({
      kind: "message",
      text: expect.stringContaining("answer-7"),
    });
  });

  it("hydrates incoming and outgoing session-message cards beside wrapped messages", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const outgoing = createConversationCardEntry({
      cardId: randomUUID(),
      kind: "delegation_task",
      body: "Review the parser",
      fromSnapshot: peer(),
      toSnapshot: peer(),
      state: "queued",
      messageId: randomUUID(),
      delegationId: randomUUID(),
      runId: randomUUID(),
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    appendReservedCustomEntry(manager, outgoing);
    manager.appendMessage(message({
      role: "user",
      content: "Continue locally",
      timestamp: 1,
    }));
    const incoming = createConversationMessageEntry({
      content: [
        "Parser review complete",
        "",
        "生命周期提醒：这段内容只供 Agent 使用。",
      ].join("\n"),
      display: true,
      details: {
        messageId: randomUUID(),
        cardId: randomUUID(),
        sentAt: "2026-07-19T10:01:00.000Z",
        kind: "message",
        body: "Parser review complete",
        summary: "解析器审查已完成，等待你决定下一步。",
        fromSnapshot: peer(),
        toSnapshot: peer(),
        delegationId: randomUUID(),
      },
    });
    manager.appendCustomMessageEntry(
      incoming.customType,
      incoming.content,
      incoming.display,
      incoming.details,
    );

    const items = projectConversationItems(manager);
    expect(items).toEqual([
      expect.objectContaining({
        kind: "session_message",
        cardId: outgoing.data.cardId,
        direction: "outgoing",
        state: "queued",
        body: "Review the parser",
        summary: "",
        sentAt: outgoing.data.updatedAt,
      }),
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "Continue locally",
      }),
      expect.objectContaining({
        kind: "session_message",
        cardId: incoming.details.cardId,
        direction: "incoming",
        state: "delivered",
        body: "Parser review complete",
        summary: "解析器审查已完成，等待你决定下一步。",
        sentAt: incoming.details.sentAt,
      }),
    ]);
    expect(JSON.stringify(items)).not.toContain("生命周期提醒");

    const snapshot = projectConversationItemsSnapshot(manager);
    expect(snapshot.items).toEqual(items);
    expect(snapshot.window).toEqual({
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    });
  });

  it("splits restored assistant bubbles across incoming messages and compaction", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const firstKeptEntryId = manager.appendMessage(message({
      role: "user",
      content: "Start a long task",
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "Before the peer reply" }],
      usage: { totalTokens: 10 },
      stopReason: "stop",
      timestamp: 2,
    }));
    const incoming = createConversationMessageEntry({
      content: "Peer result",
      display: true,
      details: {
        messageId: randomUUID(),
        cardId: randomUUID(),
        sentAt: "2026-07-19T10:01:00.000Z",
        kind: "message",
        body: "Peer result",
        fromSnapshot: peer(),
        toSnapshot: peer(),
      },
    });
    manager.appendCustomMessageEntry(
      incoming.customType,
      incoming.content,
      incoming.display,
      incoming.details,
    );
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "After the peer reply" }],
      usage: { totalTokens: 20 },
      stopReason: "stop",
      timestamp: 3,
    }));
    const compactionId = manager.appendCompaction(
      "durable summary",
      firstKeptEntryId,
      30,
    );
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "After compaction" }],
      usage: { totalTokens: 5 },
      stopReason: "stop",
      timestamp: 4,
    }));

    expect(projectConversationItems(manager)).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "Start a long task",
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "Before the peer reply",
      }),
      expect.objectContaining({
        kind: "session_message",
        cardId: incoming.details.cardId,
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "After the peer reply",
      }),
      expect.objectContaining({
        kind: "compaction",
        id: compactionId,
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "After compaction",
      }),
    ]);
  });

  it("preserves assistant part order around an outgoing session card", () => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendMessage(message({
      role: "user",
      content: "Delegate and continue",
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Plan the delegation" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "start_session",
          arguments: { task: "Review it" },
        },
      ],
      usage: { totalTokens: 10 },
      stopReason: "toolUse",
      timestamp: 2,
    }));
    const outgoing = createConversationCardEntry({
      cardId: randomUUID(),
      kind: "delegation_task",
      body: "Review it",
      fromSnapshot: peer(),
      toSnapshot: peer(),
      state: "queued",
      messageId: randomUUID(),
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    appendReservedCustomEntry(manager, outgoing);
    manager.appendMessage(message({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "start_session",
      content: [{ type: "text", text: "started" }],
      isError: false,
      timestamp: 3,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Continue locally" },
        {
          type: "toolCall",
          id: "tool-2",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      usage: { totalTokens: 20 },
      stopReason: "toolUse",
      timestamp: 4,
    }));
    manager.appendMessage(message({
      role: "toolResult",
      toolCallId: "tool-2",
      toolName: "read",
      content: [{ type: "text", text: "read" }],
      isError: false,
      timestamp: 5,
    }));
    appendReservedCustomEntry(manager, createConversationCardEntry({
      ...outgoing.data,
      state: "completed",
      result: "Review complete",
      updatedAt: "2026-07-19T10:01:00.000Z",
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "Finished locally" }],
      usage: { totalTokens: 5 },
      stopReason: "stop",
      timestamp: 6,
    }));

    expect(projectConversationItems(manager)).toEqual([
      expect.objectContaining({ kind: "message", role: "user" }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        parts: [
          { kind: "thinking", offset: 0, length: 19 },
          { kind: "tool", toolCallId: "tool-1" },
        ],
        tools: [expect.objectContaining({
          toolCallId: "tool-1",
          status: "done",
        })],
      }),
      expect.objectContaining({
        kind: "session_message",
        cardId: outgoing.data.cardId,
        state: "completed",
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        parts: [
          { kind: "thinking", offset: 0, length: 16 },
          { kind: "tool", toolCallId: "tool-2" },
          { kind: "text", offset: 0, length: 16 },
        ],
        tools: [expect.objectContaining({
          toolCallId: "tool-2",
          status: "done",
        })],
      }),
    ]);
  });

  it("updates a repeated card in place and hides host-only reserved records", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const initial = createConversationCardEntry({
      cardId: randomUUID(),
      kind: "delegation_task",
      body: "Implement the parser",
      fromSnapshot: peer(),
      toSnapshot: peer(),
      state: "queued",
      messageId: randomUUID(),
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    appendReservedCustomEntry(manager, initial);
    manager.appendMessage(message({
      role: "user",
      content: "Work in parallel",
      timestamp: 1,
    }));
    appendReservedCustomEntry(manager, createConversationCardEntry({
      ...initial.data,
      state: "completed",
      result: "Parser complete",
      updatedAt: "2026-07-19T10:02:00.000Z",
    }));
    appendReservedCustomEntry(manager, createConversationMetaEntry({
      role: {
        id: "default",
        revision: 1,
        name: "Worker",
        description: "",
        systemPrompt: "",
        model: {
          provider: "openai",
          id: "gpt-5.6",
        },
        compactionModel: null,
        defaultThinkingLevel: "off",
        defaultServiceTier: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
      lifecycle: { kind: "normal" },
      createdBy: { kind: "user" },
    }));
    appendReservedCustomEntry(manager, createRunSettlementEntry({
      runId: randomUUID(),
      outcome: "completed",
      finalText: "Internal settlement",
      settledAt: "2026-07-19T10:03:00.000Z",
    }));
    appendReservedCustomEntry(manager, createEditBudgetEntry({
      kind: "grant",
      runId: randomUUID(),
      fileCount: 1,
    }));
    const resume = createCompactionResumeEntry({
      content:
        "Continue the unfinished task from the retained context.",
      display: false,
      details: { runId: randomUUID() },
    });
    manager.appendCustomMessageEntry(
      resume.customType,
      resume.content,
      resume.display,
      resume.details,
    );

    expect(projectConversationItems(manager)).toEqual([
      expect.objectContaining({
        kind: "session_message",
        cardId: initial.data.cardId,
        state: "completed",
        result: "Parser complete",
        sentAt: initial.data.updatedAt,
        updatedAt: "2026-07-19T10:02:00.000Z",
      }),
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "Work in parallel",
      }),
    ]);
  });

  it("projects durable compaction entries as transcript boundaries", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const firstKeptEntryId = manager.appendMessage(message({
      role: "user",
      content: "first question",
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      usage: { totalTokens: 63_771 },
      stopReason: "stop",
      timestamp: 2,
    }));
    const compactionId = manager.appendCompaction(
      "durable summary",
      firstKeptEntryId,
      63_771,
    );
    manager.appendMessage(message({
      role: "user",
      content: "after compaction",
      timestamp: 3,
    }));

    expect(projectConversationItems(manager)).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "first question",
      }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "first answer",
      }),
      expect.objectContaining({
        kind: "compaction",
        id: compactionId,
        tokensBefore: 63_771,
      }),
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "after compaction",
      }),
    ]);
    expect(projectAgentConversationPeek(manager).items).toEqual([
      expect.objectContaining({ kind: "message", text: "first question" }),
      expect.objectContaining({ kind: "message", text: "first answer" }),
      expect.objectContaining({ kind: "message", text: "after compaction" }),
    ]);
  });

  it("projects only bounded strict default provenance on the active branch and gives custom hooks priority", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const asciiBoundary = "p".repeat(MAX_MODEL_REFERENCE_BYTES);
    const multibyteBoundary = `${"模".repeat(Math.floor(MAX_MODEL_REFERENCE_BYTES / 3))}x`;
    const firstKeptEntryId = manager.appendMessage(message({
      role: "user",
      content: "question",
      timestamp: 1,
    }));
    const defaultAttemptId = randomUUID();
    manager.appendCompaction("default summary", firstKeptEntryId, 100, {
      [COMPACTION_PROVENANCE_NAMESPACE]: {
        version: 1,
        attemptId: defaultAttemptId,
        generator: "default",
        policy: "follow_primary",
        requestTarget: { provider: asciiBoundary, id: multibyteBoundary },
      },
    });
    manager.appendCompaction("custom summary", firstKeptEntryId, 101, {
      [COMPACTION_PROVENANCE_NAMESPACE]: {
        version: 1,
        attemptId: randomUUID(),
        generator: "default",
        policy: "explicit",
        requestTarget: { provider: "forged", id: "forged" },
      },
    }, true);
    manager.appendCompaction("invalid summary", firstKeptEntryId, 102, {
      [COMPACTION_PROVENANCE_NAMESPACE]: { version: 2 },
    });
    const invalidTargets = [
      { provider: " \t", id: "model" },
      { provider: "provider", id: `${asciiBoundary}x` },
      { provider: `${multibyteBoundary}模`, id: "model" },
    ];
    for (const [index, requestTarget] of invalidTargets.entries()) {
      manager.appendCompaction(`invalid target ${index}`, firstKeptEntryId, 103 + index, {
        [COMPACTION_PROVENANCE_NAMESPACE]: {
          version: 1,
          attemptId: randomUUID(),
          generator: "default",
          policy: "explicit",
          requestTarget,
        },
      });
    }

    const markers = projectConversationItems(manager)
      .filter((item) => item.kind === "compaction");
    expect(markers).toEqual([
      expect.objectContaining({
        provenance: {
          generator: "default",
          attemptId: defaultAttemptId,
          policy: "follow_primary",
          requestTarget: { provider: asciiBoundary, id: multibyteBoundary },
        },
      }),
      expect.objectContaining({ provenance: { generator: "custom" } }),
      ...Array.from({ length: 4 }, () =>
        expect.not.objectContaining({ provenance: expect.anything() })),
    ]);

    manager.branch(firstKeptEntryId);
    manager.appendCompaction("replacement summary", firstKeptEntryId, 103);
    expect(projectConversationItems(manager).filter((item) => item.kind === "compaction"))
      .toEqual([expect.not.objectContaining({ provenance: expect.anything() })]);
  });

  it("keeps a compaction boundary when older oversized turns are omitted", () => {
    const manager = SessionManager.inMemory("E:\\work");
    let firstKeptEntryId = "";
    for (let index = 0; index < 8; index += 1) {
      const entryId = manager.appendMessage(message({
        role: "user",
        content: `before-${index}-${"问".repeat(80_000)}`,
        timestamp: index * 2,
      }));
      firstKeptEntryId ||= entryId;
      manager.appendMessage(message({
        role: "assistant",
        content: [{
          type: "text",
          text: `answer-${index}-${"答".repeat(80_000)}`,
        }],
        usage: { totalTokens: 10_000 },
        stopReason: "stop",
        timestamp: index * 2 + 1,
      }));
    }
    const compactionId = manager.appendCompaction(
      "durable summary",
      firstKeptEntryId,
      80_000,
    );
    manager.appendMessage(message({
      role: "user",
      content: "after compaction",
      timestamp: 20,
    }));

    const snapshot = projectConversationItemsSnapshot(manager);
    expect(snapshot.window.omittedBefore).toBe(true);
    expect(snapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "compaction",
        id: compactionId,
      }),
      expect.objectContaining({
        kind: "message",
        role: "user",
        text: "after compaction",
      }),
    ]));
  });

  it("fails closed instead of rendering unknown piweb reserved records", () => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendCustomEntry("piweb.future.v2", {});

    expect(() => projectConversationItems(manager)).toThrow(
      /unknown piweb reserved/i,
    );
  });

  it("projects only visible message text and session-message cards for Agent peek", () => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendMessage(message({
      role: "user",
      content: "Inspect this",
      timestamp: 1,
    }));
    manager.appendMessage(message({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private chain" },
        {
          type: "toolCall",
          id: "tool-private",
          name: "read",
          arguments: { secret: "private args" },
        },
        { type: "text", text: "Visible answer" },
      ],
      usage: { totalTokens: 9 },
      stopReason: "toolUse",
      timestamp: 2,
    }));
    manager.appendMessage(message({
      role: "toolResult",
      toolCallId: "tool-private",
      toolName: "read",
      content: [{ type: "text", text: "private tool result" }],
      isError: false,
      timestamp: 3,
    }));
    appendReservedCustomEntry(manager, createConversationMetaEntry({
      role: {
        id: "default",
        revision: 1,
        name: "Worker",
        description: "",
        systemPrompt: "internal prompt",
        model: { provider: "openai", id: "gpt-5.6" },
        compactionModel: null,
        defaultThinkingLevel: "off",
        defaultServiceTier: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
      lifecycle: { kind: "normal" },
      createdBy: { kind: "user" },
    }));
    manager.appendCustomMessageEntry(
      "provider.auth.request",
      "private auth prompt",
      true,
      { token: "private auth token" },
    );
    const card = createConversationCardEntry({
      cardId: randomUUID(),
      kind: "message",
      body: "Visible peer message",
      fromSnapshot: peer(),
      toSnapshot: peer(),
      state: "delivered",
      messageId: randomUUID(),
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    appendReservedCustomEntry(manager, card);

    const peek = projectAgentConversationPeek(manager);
    expect(peek).toMatchObject({
      truncated: false,
      items: [
        {
          kind: "message",
          role: "user",
          text: "Inspect this",
        },
        {
          kind: "message",
          role: "assistant",
          text: "Visible answer",
        },
        {
          kind: "session_message",
          cardId: card.data.cardId,
          body: "Visible peer message",
        },
      ],
    });
    const serialized = JSON.stringify(peek);
    expect(serialized).not.toContain("private chain");
    expect(serialized).not.toContain("private args");
    expect(serialized).not.toContain("private tool result");
    expect(serialized).not.toContain("internal prompt");
    expect(serialized).not.toContain("private auth");
    expect(serialized).not.toContain("usage");
  });

  it("bounds Agent peek to the newest 20 items", () => {
    const manager = SessionManager.inMemory("E:\\work");
    for (let index = 0; index < 30; index += 1) {
      manager.appendMessage(message({
        role: "user",
        content: `question-${index}`,
        timestamp: index,
      }));
    }

    const peek = projectAgentConversationPeek(manager, 100);
    expect(peek.truncated).toBe(true);
    expect(peek.items).toHaveLength(MAX_AGENT_PEEK_ITEMS);
    expect(peek.items[0]).toMatchObject({
      kind: "message",
      text: "question-10",
    });
    expect(peek.items.at(-1)).toMatchObject({
      kind: "message",
      text: "question-29",
    });
  });

  it("keeps an escaped newest Agent peek item instead of returning an empty tail", () => {
    const manager = SessionManager.inMemory("E:\\work");
    manager.appendMessage(message({
      role: "user",
      content: `latest question ${"\u0000".repeat(80_000)}`,
      timestamp: 1,
    }));

    const peek = projectAgentConversationPeek(manager);

    expect(peek.items).toEqual([expect.objectContaining({
      kind: "message",
      role: "user",
      text: expect.stringContaining("latest question"),
    })]);
    expect(peek.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(peek), "utf8"))
      .toBeLessThanOrEqual(MAX_AGENT_PEEK_BYTES);
  });

  it("keeps an escaped newest Agent card while preserving its identity", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const cardId = randomUUID();
    appendReservedCustomEntry(manager, createConversationCardEntry({
      cardId,
      kind: "message",
      body: `latest card ${"\u0000".repeat(80_000)}`,
      fromSnapshot: peer(),
      toSnapshot: peer(),
      state: "completed",
      messageId: randomUUID(),
      result: `latest result ${"\u0000".repeat(80_000)}`,
      updatedAt: "2026-07-31T10:00:00.000Z",
    }));

    const peek = projectAgentConversationPeek(manager);

    expect(peek.items).toEqual([expect.objectContaining({
      kind: "session_message",
      cardId,
      body: expect.stringContaining("latest card"),
      result: expect.stringContaining("latest result"),
    })]);
    expect(peek.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(peek), "utf8"))
      .toBeLessThanOrEqual(MAX_AGENT_PEEK_BYTES);
  });

  it("bounds the complete serialized Agent peek snapshot to 256 KiB", () => {
    const manager = SessionManager.inMemory("E:\\work");
    for (let index = 0; index < 20; index += 1) {
      manager.appendMessage(message({
        role: "user",
        content: `question-${index}-${"问".repeat(20_000)}`,
        timestamp: index,
      }));
    }

    const peek = projectAgentConversationPeek(manager);
    expect(peek.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(peek), "utf8"))
      .toBeLessThanOrEqual(MAX_AGENT_PEEK_BYTES);
    expect(peek.items.at(-1)).toMatchObject({
      kind: "message",
      text: expect.stringContaining("question-19"),
    });
  });
});
