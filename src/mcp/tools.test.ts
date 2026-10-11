import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { ConversationHistoryItem } from "../shared/protocol.js";
import { clip, formatHistoryItem, lastAgentReply } from "./conversation-text.js";
import { PiWebBridge, type ConversationReadResult } from "./piweb-bridge.js";
import { formatRead, formatWait, registerPiWebTools } from "./tools.js";

const RUN = "11111111-1111-4111-8111-111111111111";

function message(
  role: "user" | "assistant",
  text: string,
  extra: Partial<Extract<ConversationHistoryItem, { kind: "message" }>> = {},
): ConversationHistoryItem {
  return { kind: "message", id: `${role}-${text}`, role, text, thinking: "", tools: [], parts: [], ...extra };
}

function read(items: ConversationHistoryItem[]): ConversationReadResult {
  return {
    cwd: "E:\\project",
    conversationId: "conversation-1",
    title: "测试",
    role: { name: "默认", model: { provider: "deepseek", id: "deepseek-chat" }, toolMode: "full_access" },
    activeRun: undefined,
    pendingPrompts: 0,
    loopList: { items: [{ text: "写测试", status: "active" }], armed: true },
    items,
    lastReply: lastAgentReply(items),
    totalItems: items.length,
    omittedBefore: false,
  };
}

describe("conversation text projection", () => {
  it("clips by code point and reports the original length", () => {
    expect(clip("短", 5)).toBe("短");
    expect(clip("😀😀😀", 2)).toBe("😀😀…（已截断，共 3 字）");
  });

  it("summarizes tools without dumping results unless they failed", () => {
    const text = formatHistoryItem(message("assistant", "完成了", {
      runId: RUN,
      tools: [
        { toolCallId: "a", toolName: "read", args: { path: "a.ts" }, result: "很长的文件内容", status: "done" },
        { toolCallId: "b", toolName: "bash", args: { command: "npm test" }, result: { error: "boom" }, status: "error" },
      ],
    }), 100);
    expect(text).toContain(`[Agent] run=${RUN}`);
    expect(text).toContain('工具 read {"path":"a.ts"}：完成');
    expect(text).not.toContain("很长的文件内容");
    expect(text).toContain('工具 bash {"command":"npm test"}：出错 → {"error":"boom"}');
  });

  it("finds the last non-empty agent reply", () => {
    expect(lastAgentReply([
      message("assistant", "第一条"),
      message("user", "继续"),
      message("assistant", "  "),
    ])).toBe("第一条");
    expect(lastAgentReply([message("user", "你好")])).toBeUndefined();
  });

  it("formats reads and settlements for the caller", () => {
    const history = [message("user", "[Claude Code] 写测试"), message("assistant", "写好了")];
    const readText = formatRead(read(history));
    expect(readText).toContain("默认（deepseek/deepseek-chat，完全权限）");
    expect(readText).toContain("任务清单（自动续跑中）");
    expect(readText).toContain("[>] 写测试");
    expect(formatWait({
      kind: "settled",
      settlement: {
        type: "conversation_run_settled",
        sessionId: "22222222-2222-4222-8222-222222222222",
        projectId: "33333333-3333-4333-8333-333333333333",
        conversationId: "conversation-1",
        runId: RUN,
        outcome: "completed",
        createdBy: { kind: "user" },
      },
      after: read(history),
      others: [],
    })).toContain("正常完成");
  });
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("MCP tool registration", () => {
  it("exposes the bridge tools and turns connection failures into tool errors", async () => {
    const port = await closedPort();
    const bridge = new PiWebBridge({
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      defaultCwd: tmpdir(),
    });
    const server = new McpServer({ name: "piweb-test", version: "0.0.0" });
    registerPiWebTools(server, bridge);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual([
        "piweb_abort",
        "piweb_create_conversation",
        "piweb_list_conversations",
        "piweb_list_roles",
        "piweb_read_conversation",
        "piweb_send_message",
        "piweb_start",
        "piweb_wait",
      ]);
      const wait = tools.find(({ name }) => name === "piweb_wait")!;
      expect(wait.inputSchema.required).toEqual(["conversationIds"]);

      const result = await client.callTool({ name: "piweb_list_conversations", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("无法连接 Pi Web");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
