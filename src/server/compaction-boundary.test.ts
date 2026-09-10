import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCompactionBoundary } from "./compaction-boundary.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function assistantToolCall(toolCallId: string): AgentMessage {
  return message({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: toolCallId,
      name: "read",
      arguments: { path: `${toolCallId}.txt` },
    }],
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
}

function assistantText(text: string): AgentMessage {
  return message({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function toolResult(toolCallId: string): AgentMessage {
  return message({
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: `result for ${toolCallId}` }],
    isError: false,
    timestamp: Date.now(),
  });
}

function expectNoOrphanToolResults(manager: SessionManager): void {
  const messages = manager.buildSessionContext().messages;
  for (let resultIndex = 0; resultIndex < messages.length; resultIndex++) {
    const result = messages[resultIndex];
    if (result.role !== "toolResult") continue;
    const hasEarlierCall = messages.slice(0, resultIndex).some((candidate) => (
      candidate.role === "assistant"
      && Array.isArray(candidate.content)
      && candidate.content.some((part) => (
        part.type === "toolCall" && part.id === result.toolCallId
      ))
    ));
    expect(hasEarlierCall, `orphan tool result ${result.toolCallId}`).toBe(true);
  }
}

function latestCompaction(manager: SessionManager) {
  return manager.getEntries().findLast((entry) => entry.type === "compaction");
}

describe("installCompactionBoundary", () => {
  it.each([
    ["plain custom metadata", "metadata"],
    ["context-visible custom message", "custom-message"],
  ] as const)(
    "rewinds a %s boundary across card metadata and a custom message",
    async (_label, proposedAt) => {
      const cwd = await temporaryDirectory("piweb-compaction-boundary-");
      const manager = SessionManager.create(cwd, cwd);
      const assistantId = manager.appendMessage(assistantToolCall("tool-1"));
      const metadataId = manager.appendCustomEntry(
        "piweb.conversation_card.v1",
        { cardId: "card-1", state: "completed" },
      );
      const customMessageId = manager.appendCustomMessageEntry(
        "piweb.conversation_message.v1",
        "A peer supplied more context.",
        true,
        { messageId: "message-1" },
      );
      manager.appendMessage(toolResult("tool-1"));
      const adapter = installCompactionBoundary(manager);

      manager.appendCompaction(
        "summary",
        proposedAt === "metadata" ? metadataId : customMessageId,
        100,
      );

      const sessionFile = manager.getSessionFile();
      if (!sessionFile) throw new Error("test session was not persisted");
      const persisted = (await readFile(sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const compaction = persisted.findLast((entry) => entry.type === "compaction");
      expect(compaction?.firstKeptEntryId).toBe(assistantId);
      expectNoOrphanToolResults(manager);

      const context = manager.buildSessionContext().messages;
      const callIndex = context.findIndex((candidate) => (
        candidate.role === "assistant"
        && Array.isArray(candidate.content)
        && candidate.content.some((part) => part.type === "toolCall" && part.id === "tool-1")
      ));
      const resultIndex = context.findIndex((candidate) => (
        candidate.role === "toolResult" && candidate.toolCallId === "tool-1"
      ));
      expect(callIndex).toBeGreaterThanOrEqual(0);
      expect(resultIndex).toBeGreaterThan(callIndex);
      adapter.dispose();
    },
  );

  it("leaves an already safe boundary unchanged", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const assistantId = manager.appendMessage(assistantToolCall("tool-safe"));
    manager.appendMessage(toolResult("tool-safe"));
    const adapter = installCompactionBoundary(manager);

    manager.appendCompaction("summary", assistantId, 20);

    expect(latestCompaction(manager)).toMatchObject({
      firstKeptEntryId: assistantId,
    });
    expectNoOrphanToolResults(manager);
    adapter.dispose();
  });

  it("rewinds to a fixed point across more than one tool dependency", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const firstCallId = manager.appendMessage(assistantToolCall("tool-1"));
    const secondCallId = manager.appendMessage(assistantToolCall("tool-2"));
    manager.appendMessage(toolResult("tool-1"));
    const proposedBoundary = manager.appendCustomEntry("card.metadata", { state: "done" });
    manager.appendMessage(toolResult("tool-2"));
    const adapter = installCompactionBoundary(manager);

    manager.appendCompaction("summary", proposedBoundary, 40);

    expect(secondCallId).not.toBe(firstCallId);
    expect(latestCompaction(manager)).toMatchObject({
      firstKeptEntryId: firstCallId,
    });
    expectNoOrphanToolResults(manager);
    adapter.dispose();
  });

  it.each([
    ["missing", (manager: SessionManager) => manager.appendMessage(toolResult("tool-missing"))],
    ["misordered", (manager: SessionManager) => {
      const resultId = manager.appendMessage(toolResult("tool-late"));
      manager.appendMessage(assistantToolCall("tool-late"));
      return resultId;
    }],
  ])("fails closed without appending for a %s tool call", (_label, arrange) => {
    const manager = SessionManager.inMemory("E:\\work");
    const proposedBoundary = arrange(manager);
    const entriesBefore = manager.getEntries();
    const leafBefore = manager.getLeafId();
    const adapter = installCompactionBoundary(manager);

    expect(() => manager.appendCompaction("summary", proposedBoundary, 10)).toThrow(
      /strictly earlier assistant toolCall/,
    );
    expect(manager.getEntries()).toEqual(entriesBefore);
    expect(manager.getLeafId()).toBe(leafBefore);
    expect(latestCompaction(manager)).toBeUndefined();
    adapter.dispose();
  });

  it("fails closed when the proposed entry is not on the active branch", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const rootId = manager.appendCustomEntry("root", {});
    const abandonedId = manager.appendMessage(assistantText("abandoned"));
    manager.branch(rootId);
    manager.appendMessage(assistantText("active"));
    const entriesBefore = manager.getEntries();
    const leafBefore = manager.getLeafId();
    const adapter = installCompactionBoundary(manager);

    expect(() => manager.appendCompaction("summary", abandonedId, 10)).toThrow(
      /active branch/,
    );
    expect(manager.getEntries()).toEqual(entriesBefore);
    expect(manager.getLeafId()).toBe(leafBefore);
    adapter.dispose();
  });

  it("restores an existing own descriptor exactly", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const inheritedMethod = manager.appendCompaction;
    const originalDescriptor = {
      configurable: true,
      enumerable: true,
      writable: false,
      value: inheritedMethod,
    };
    Object.defineProperty(manager, "appendCompaction", originalDescriptor);

    const adapter = installCompactionBoundary(manager);
    expect(manager.appendCompaction).not.toBe(inheritedMethod);

    adapter.dispose();

    expect(Object.getOwnPropertyDescriptor(manager, "appendCompaction")).toEqual(
      originalDescriptor,
    );
  });

  it("restores the inherited method and disposes idempotently", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const inheritedMethod = manager.appendCompaction;
    expect(Object.hasOwn(manager, "appendCompaction")).toBe(false);
    const adapter = installCompactionBoundary(manager);
    expect(Object.hasOwn(manager, "appendCompaction")).toBe(true);

    adapter.dispose();
    adapter.dispose();
    expect(Object.hasOwn(manager, "appendCompaction")).toBe(false);
    expect(manager.appendCompaction).toBe(inheritedMethod);
  });

  it("does not overwrite a method installed by a later owner", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const adapter = installCompactionBoundary(manager);
    const replacement = vi.fn() as unknown as SessionManager["appendCompaction"];
    manager.appendCompaction = replacement;

    adapter.dispose();

    expect(manager.appendCompaction).toBe(replacement);
  });

  it("does not overwrite a descriptor changed by a later owner", () => {
    const manager = SessionManager.inMemory("E:\\work");
    const adapter = installCompactionBoundary(manager);
    const wrapped = manager.appendCompaction;
    const laterDescriptor = {
      configurable: false,
      enumerable: true,
      writable: true,
      value: wrapped,
    };
    Object.defineProperty(manager, "appendCompaction", laterDescriptor);

    expect(() => adapter.dispose()).not.toThrow();
    expect(Object.getOwnPropertyDescriptor(manager, "appendCompaction")).toEqual(
      laterDescriptor,
    );
  });
});
