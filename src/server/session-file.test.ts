import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePiSessionFile } from "./session-file.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function serialize(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("validatePiSessionFile", () => {
  it("accepts the current Pi entry variants and tree links", () => {
    const conversationId = randomUUID();
    const base = (type: string, id: string, parentId: string | null) => ({
      type,
      id,
      parentId,
      timestamp,
    });
    const entries = [
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      { ...base("thinking_level_change", "00000001", null), thinkingLevel: "high" },
      {
        ...base("model_change", "00000002", "00000001"),
        provider: "provider",
        modelId: "model",
      },
      {
        ...base("custom", "00000003", "00000002"),
        customType: "extension-state",
        data: { count: 1 },
      },
      {
        ...base("custom_message", "00000004", "00000003"),
        customType: "extension-context",
        content: "context",
        display: true,
      },
      {
        ...base("message", "00000005", "00000004"),
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        ...base("message", "00000006", "00000005"),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "test-api",
          provider: "provider",
          model: "model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        ...base("message", "00000007", "00000006"),
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        ...base("compaction", "00000008", "00000007"),
        summary: "summary",
        firstKeptEntryId: "00000005",
        tokensBefore: 100,
      },
      {
        ...base("branch_summary", "00000009", "00000005"),
        fromId: "00000008",
        summary: "other branch",
      },
      {
        ...base("label", "0000000a", "00000009"),
        targetId: "00000005",
        label: "checkpoint",
      },
      {
        ...base("session_info", "0000000b", "0000000a"),
        name: "Conversation",
      },
    ];

    expect(validatePiSessionFile(
      serialize(entries),
      "session.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it("validates legacy linear entries after Pi's in-memory migration", () => {
    const conversationId = randomUUID();
    const legacy = serialize([
      {
        type: "session",
        version: 1,
        id: conversationId,
        timestamp,
      },
      {
        type: "message",
        timestamp,
        message: { role: "user", content: "legacy" },
      },
      {
        type: "session_info",
        timestamp,
        name: "Legacy",
      },
    ]);

    expect(validatePiSessionFile(
      legacy,
      "legacy.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it("accepts Pi's root branch-summary sentinel", () => {
    const conversationId = randomUUID();
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "",
      },
      {
        type: "branch_summary",
        id: "00000001",
        parentId: null,
        timestamp,
        fromId: "root",
        summary: "root branch",
      },
    ]);

    expect(validatePiSessionFile(
      session,
      "root-branch.jsonl",
      conversationId,
    )).toBe(conversationId);
  });

  it("rejects compaction state borrowed from another branch", () => {
    const conversationId = randomUUID();
    const base = (type: string, id: string, parentId: string | null) => ({
      type,
      id,
      parentId,
      timestamp,
    });
    const session = serialize([
      {
        type: "session",
        version: 3,
        id: conversationId,
        timestamp,
        cwd: "E:\\work",
      },
      {
        ...base("message", "00000001", null),
        message: { role: "user", content: "root", timestamp: 1 },
      },
      {
        ...base("message", "00000002", "00000001"),
        message: { role: "user", content: "other branch", timestamp: 2 },
      },
      {
        ...base("message", "00000003", "00000001"),
        message: { role: "user", content: "active branch", timestamp: 3 },
      },
      {
        ...base("compaction", "00000004", "00000003"),
        summary: "invalid",
        firstKeptEntryId: "00000002",
        tokensBefore: 100,
      },
    ]);

    expect(() => validatePiSessionFile(
      session,
      "cross-branch-compaction.jsonl",
      conversationId,
    )).toThrow("firstKeptEntryId is not an ancestor");
  });
});
