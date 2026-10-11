import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  activityText,
  clip,
  formatConversationList,
  formatHistoryItem,
  formatRoleList,
} from "./conversation-text.js";
import type {
  AbortResult,
  ConversationReadResult,
  PiWebBridge,
  WaitResult,
} from "./piweb-bridge.js";
import { PiWebBridgeError, type PromptAck } from "./piweb-session.js";

const DEFAULT_LAST_ITEMS = 8;
const MAX_LAST_ITEMS = 50;
const ITEM_MAX_CHARACTERS = 4_000;
const REPLY_MAX_CHARACTERS = 12_000;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 3_600;

export function piWebInstructions(defaultCwd: string): string {
  return [
    "Pi Web 是用户本机的多 Agent 工作台（DeepSeek 等模型在其中运行）。这些工具让你像用户一样操作它：查看会话、新建会话、发消息、等待结果、停止运行。",
    "- 你发出的消息会自动加上 \"[Claude Code] \" 前缀，在 Pi Web 中显示为用户消息；对方 Agent 据此知道是你在说话。",
    "- 发消息后用 piweb_wait 等待本轮结束；它会返回 Agent 的最新回复。需要更多上下文时再用 piweb_read_conversation。",
    "- 工具若报告项目信任还没有决定，或 Pi Web 弹出了对话框，不要绕过或重试，把内容告诉用户，由用户在浏览器中处理。",
    "- 本工具集不提供删除会话、修改角色或认证的操作。",
    `- 省略 cwd 时使用默认项目目录：${defaultCwd}`,
  ].join("\n");
}

const cwdSchema = z.string().max(4096).optional()
  .describe("Pi Web 项目目录的绝对路径；省略时使用默认项目目录");
const conversationIdSchema = z.string().min(1).max(256)
  .describe("会话 ID（piweb_list_conversations 返回的完整 ID）");
const lastItemsSchema = z.number().int().min(1).max(MAX_LAST_ITEMS).optional()
  .describe(`返回最近多少条历史，默认 ${DEFAULT_LAST_ITEMS}`);

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof PiWebBridgeError
    ? error.message
    : `Pi Web 桥内部错误：${error instanceof Error ? error.message : String(error)}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(work: () => Promise<string>): Promise<CallToolResult> {
  try {
    return text(await work());
  } catch (error) {
    return failure(error);
  }
}

function roleText(read: ConversationReadResult): string {
  if (read.role === undefined) return "未知角色";
  const access = read.role.toolMode === "full_access" ? "完全权限" : "只读";
  return `${read.role.name}（${read.role.model.provider}/${read.role.model.id}，${access}）`;
}

function runText(read: ConversationReadResult): string {
  const run = read.activeRun === undefined
    ? "空闲"
    : activityText({ kind: read.activeRun.phase, runId: read.activeRun.id });
  return read.pendingPrompts > 0 ? `${run}；另有 ${read.pendingPrompts} 条已保存、尚未交给 Agent 的消息` : run;
}

export function formatRead(read: ConversationReadResult): string {
  const lines = [
    `会话 ${read.conversationId}｜${read.title ?? "未命名"}｜${roleText(read)}`,
    `项目：${read.cwd}`,
    `状态：${runText(read)}`,
  ];
  if (read.loopList && read.loopList.items.length > 0) {
    const mark = { pending: "[ ]", active: "[>]", completed: "[x]" } as Record<string, string>;
    lines.push(`任务清单${read.loopList.armed ? "（自动续跑中）" : ""}：`);
    for (const item of read.loopList.items) lines.push(`  ${mark[item.status] ?? "[?]"} ${item.text}`);
  }
  if (read.items.length === 0) {
    lines.push("还没有历史记录。");
  } else {
    lines.push(`最近 ${read.items.length} 条${read.omittedBefore ? `（共 ${read.totalItems} 条，更早的已省略）` : ""}：`);
    for (const item of read.items) {
      lines.push("", formatHistoryItem(item, ITEM_MAX_CHARACTERS));
    }
  }
  return lines.join("\n");
}

function replyText(read: ConversationReadResult): string {
  return read.lastReply === undefined
    ? "（还没有 Agent 回复）"
    : clip(read.lastReply, REPLY_MAX_CHARACTERS);
}

const OUTCOME_TEXT = { completed: "正常完成", aborted: "被中止", failed: "失败" } as const;

export function formatWait(result: WaitResult): string {
  switch (result.kind) {
    case "timeout":
      return [
        "等待超时，目标会话仍在运行：",
        ...result.activities.map(({ conversationId, activity }) =>
          `- ${conversationId}：${activityText(activity)}`),
        "可以再次调用 piweb_wait 继续等待。",
      ].join("\n");
    case "idle":
      return [
        `会话 ${result.conversationId} 现在空闲。`,
        `当前状态：${runText(result.after)}`,
        "最新 Agent 回复：",
        replyText(result.after),
      ].join("\n");
    case "settled": {
      const lines = [
        `会话 ${result.settlement.conversationId} 的一轮已结束：${OUTCOME_TEXT[result.settlement.outcome]}（run=${result.settlement.runId}）。`,
        `当前状态：${runText(result.after)}`,
      ];
      if (result.after.activeRun !== undefined || result.after.pendingPrompts > 0) {
        lines.push("会话还有后续工作，可以再次调用 piweb_wait。");
      }
      if (result.others.length > 0) {
        lines.push("其它等待中的会话：", ...result.others.map(({ conversationId, activity }) =>
          `- ${conversationId}：${activityText(activity)}`));
      }
      lines.push("最新 Agent 回复：", replyText(result.after));
      return lines.join("\n");
    }
  }
}

export function formatAck(conversationId: string, ack: PromptAck): string {
  return ack.kind === "started"
    ? `Pi Web 已保存消息，会话 ${conversationId} 开始新一轮（run=${ack.runId}）。用 piweb_wait 等待结果。`
    : `会话 ${conversationId} 正在运行（run=${ack.runId}），Pi Web 已保存消息并排队，会在合适时机交给 Agent，无需重发。用 piweb_wait 等待结果。`;
}

function formatAbort(conversationId: string, result: AbortResult): string {
  if (result.kind === "idle") return `会话 ${conversationId} 当前空闲，没有需要停止的运行。`;
  return result.outcome === "unknown"
    ? `已请求停止会话 ${conversationId} 的 run=${result.runId}，但 30 秒内没有确认结束。可以用 piweb_read_conversation 查看状态。`
    : `会话 ${conversationId} 的 run=${result.runId} 已结束：${OUTCOME_TEXT[result.outcome]}。已保存但尚未交给 Agent 的消息不会被撤销，之后会自动投递。`;
}

export function registerPiWebTools(server: McpServer, bridge: PiWebBridge): void {
  server.registerTool("piweb_list_conversations", {
    title: "列出 Pi Web 会话",
    description: "列出一个 Pi Web 项目里的全部会话：ID、标题、角色与模型、空闲或运行中、谁创建的。",
    inputSchema: { cwd: cwdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ cwd }, extra) => run(async () => {
    const result = await bridge.listConversations(cwd, extra.signal);
    return formatConversationList(result.cwd, result.conversations, result.truncated);
  }));

  server.registerTool("piweb_list_roles", {
    title: "列出 Pi Web 角色",
    description: "列出新建会话时可选的角色：角色 ID、名称、模型、权限、是否可用。",
    inputSchema: { cwd: cwdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ cwd }, extra) => run(async () => formatRoleList(await bridge.listRoles(cwd, extra.signal))));

  server.registerTool("piweb_read_conversation", {
    title: "读取 Pi Web 会话",
    description: "读取一个会话的状态和最近的历史：用户消息、Agent 回复、工具调用摘要、会话间消息卡片和任务清单。",
    inputSchema: {
      cwd: cwdSchema,
      conversationId: conversationIdSchema,
      lastItems: lastItemsSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ cwd, conversationId, lastItems }, extra) => run(async () => formatRead(
    await bridge.readConversation({
      ...(cwd === undefined ? {} : { cwd }),
      conversationId,
      lastItems: lastItems ?? DEFAULT_LAST_ITEMS,
      signal: extra.signal,
    }),
  )));

  server.registerTool("piweb_create_conversation", {
    title: "新建 Pi Web 会话并派发任务",
    description: "用指定角色新建一个会话，并把任务作为第一条消息发给它。返回新会话 ID；之后用 piweb_wait 等待结果。",
    inputSchema: {
      cwd: cwdSchema,
      roleId: z.string().min(1).max(256).describe("角色 ID（piweb_list_roles 返回）"),
      title: z.string().max(200).optional().describe("会话标题，最多 24 个字，超出部分截掉；省略时由 Pi Web 自动生成"),
      task: z.string().min(1).describe("交给 Agent 的完整任务说明"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ cwd, roleId, title, task }, extra) => run(async () => {
    const result = await bridge.createConversation({
      ...(cwd === undefined ? {} : { cwd }),
      roleId,
      ...(title === undefined ? {} : { title }),
      task,
      signal: extra.signal,
    });
    return `已在 ${result.cwd} 新建会话 ${result.conversationId}${result.title === undefined ? "" : `「${result.title}」`}。\n${formatAck(result.conversationId, result.ack)}`;
  }));

  server.registerTool("piweb_send_message", {
    title: "给 Pi Web 会话发消息",
    description: "给一个会话发消息。会话空闲时开始新一轮；会话运行中时消息会保存并在合适时机交给 Agent。Pi Web 确认保存后才返回。",
    inputSchema: {
      cwd: cwdSchema,
      conversationId: conversationIdSchema,
      message: z.string().min(1).describe("消息正文；会自动加上 [Claude Code] 前缀"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ cwd, conversationId, message }, extra) => run(async () => {
    const result = await bridge.sendMessage({
      ...(cwd === undefined ? {} : { cwd }),
      conversationId,
      message,
      signal: extra.signal,
    });
    return formatAck(result.conversationId, result.ack);
  }));

  server.registerTool("piweb_wait", {
    title: "等待 Pi Web 会话",
    description: "等待一个或多个会话中的任意一个结束当前这一轮（或已经空闲），返回结果和 Agent 的最新回复。超时只说明还在运行，可以再次调用。",
    inputSchema: {
      cwd: cwdSchema,
      conversationIds: z.array(conversationIdSchema).min(1).max(32)
        .describe("要等待的会话 ID，任意一个结束即返回"),
      timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional()
        .describe(`最长等待秒数，默认 ${DEFAULT_WAIT_SECONDS}`),
      lastItems: lastItemsSchema,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ cwd, conversationIds, timeoutSeconds, lastItems }, extra) => run(async () => formatWait(
    await bridge.waitForConversations({
      ...(cwd === undefined ? {} : { cwd }),
      conversationIds,
      timeoutMs: (timeoutSeconds ?? DEFAULT_WAIT_SECONDS) * 1_000,
      lastItems: lastItems ?? DEFAULT_LAST_ITEMS,
      signal: extra.signal,
    }),
  )));

  server.registerTool("piweb_abort", {
    title: "停止 Pi Web 会话当前运行",
    description: "停止一个会话正在进行的这一轮。已保存但尚未交给 Agent 的消息不会被撤销。",
    inputSchema: {
      cwd: cwdSchema,
      conversationId: conversationIdSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, ({ cwd, conversationId }, extra) => run(async () => formatAbort(
    conversationId,
    await bridge.abort({
      ...(cwd === undefined ? {} : { cwd }),
      conversationId,
      signal: extra.signal,
    }),
  )));
}
