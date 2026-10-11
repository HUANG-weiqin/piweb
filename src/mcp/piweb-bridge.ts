import { resolve } from "node:path";
import {
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  MAX_PROMPT_CHARACTERS,
  type ConversationActivity,
  type ConversationHistoryItem,
  type RoleTemplate,
} from "../shared/protocol.js";
import { CLAUDE_MESSAGE_PREFIX, lastAgentReply } from "./conversation-text.js";
import { startPiWeb, type StartOptions, type StartResult } from "./piweb-launcher.js";
import {
  PiWebBridgeError,
  PiWebSession,
  type InitializeTarget,
  type ProjectSnapshot,
  type PromptAck,
  type RunSettlement,
} from "./piweb-session.js";

export type ProjectConversation = ProjectSnapshot["conversations"][number];

export interface BridgeOptions {
  readonly baseUrl: URL;
  readonly defaultCwd: string;
  /** 单步命令（握手、打开会话、发送确认）的超时。 */
  readonly commandTimeoutMs?: number;
  /** 本桥所在的 Pi Web 仓库；piweb_start 只从这里启动，保证服务端与桥是同一份代码。 */
  readonly repoRoot?: string;
  /** 测试注入：替换真实的分离启动与就绪等待参数。 */
  readonly launcher?: Pick<StartOptions, "launch" | "readyTimeoutMs" | "pollIntervalMs">;
}

export interface ConversationListResult {
  readonly cwd: string;
  readonly conversations: ProjectConversation[];
  readonly truncated: boolean;
}

export interface ConversationReadResult {
  readonly cwd: string;
  readonly conversationId: string;
  readonly title: string | undefined;
  readonly role: { name: string; model: { provider: string; id: string }; toolMode: string } | undefined;
  readonly activeRun: { id: string; phase: string } | undefined;
  readonly pendingPrompts: number;
  readonly loopList: { items: { text: string; status: string }[]; armed: boolean } | undefined;
  readonly items: ConversationHistoryItem[];
  /** 整个快照里最后一条 Agent 回复，不受 lastItems 截取影响。 */
  readonly lastReply: string | undefined;
  readonly totalItems: number;
  readonly omittedBefore: boolean;
}

export interface SendResult {
  readonly cwd: string;
  readonly conversationId: string;
  readonly ack: PromptAck;
}

export type WaitResult =
  | {
      readonly kind: "settled";
      readonly settlement: RunSettlement;
      readonly after: ConversationReadResult;
      readonly others: { conversationId: string; activity: ConversationActivity | undefined }[];
    }
  | {
      readonly kind: "idle";
      readonly conversationId: string;
      readonly after: ConversationReadResult;
    }
  | {
      readonly kind: "timeout";
      readonly activities: { conversationId: string; activity: ConversationActivity | undefined }[];
    };

export type AbortResult =
  | { readonly kind: "idle" }
  | { readonly kind: "aborted"; readonly runId: string; readonly outcome: RunSettlement["outcome"] | "unknown" };

function missingConversationError(conversationId: string): PiWebBridgeError {
  return new PiWebBridgeError(
    `项目里找不到会话 ${conversationId}。可先用 piweb_list_conversations 查看。`,
    "invalid_input",
  );
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const ABORT_SETTLE_TIMEOUT_MS = 30_000;
const LOOKUP_GRACE_MS = 5_000;
const IDLE_SETTLEMENT_GRACE_MS = 1_500;

function isBusy(activity: ConversationActivity | undefined): boolean {
  return activity !== undefined && activity.kind !== "idle";
}

/**
 * Claude Code 侧的 Pi Web 操作。每次调用开一条短连接，做完即断开。
 * 连接声明不接收扩展 UI，所以聚焦任何会话都不会接走浏览器的对话框。
 */
export class PiWebBridge {
  readonly defaultCwd: string;
  private readonly commandTimeoutMs: number;

  constructor(private readonly options: BridgeOptions) {
    this.defaultCwd = resolve(options.defaultCwd);
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /** 已在运行就不启动；启动或复用后都用一次握手确认协议版本与本桥一致。 */
  async start(signal?: AbortSignal): Promise<StartResult> {
    if (this.options.repoRoot === undefined) {
      throw new PiWebBridgeError("没有配置 Pi Web 项目目录，无法启动", "invalid_input");
    }
    const launch = await startPiWeb({
      baseUrl: this.options.baseUrl,
      repoRoot: this.options.repoRoot,
      ...this.options.launcher,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      const session = await PiWebSession.connect(this.options.baseUrl, signal);
      await session.close();
    } catch (error) {
      if (
        launch.kind === "already_running"
        && error instanceof PiWebBridgeError
        && error.code === "protocol_mismatch"
      ) {
        throw new PiWebBridgeError(
          `Pi Web 已在运行，但它和转接程序不是同一版本代码。${error.message}`,
          "protocol_mismatch",
        );
      }
      throw error;
    }
    return launch;
  }

  resolveCwd(cwd: string | undefined): string {
    return cwd === undefined || cwd.trim() === "" ? this.defaultCwd : resolve(cwd.trim());
  }

  private async withSession<T>(
    cwd: string,
    target: InitializeTarget,
    signal: AbortSignal | undefined,
    work: (session: PiWebSession) => Promise<T>,
  ): Promise<T> {
    const session = await PiWebSession.connect(this.options.baseUrl, signal);
    try {
      try {
        await session.initialize(cwd, target, this.commandTimeoutMs, signal);
      } catch (error) {
        // 服务端对找不到的会话只回英文原文；只翻译这一种，其它打开失败保持原样。
        if (
          target.kind === "open"
          && error instanceof PiWebBridgeError
          && error.code === "command_failed"
          && /Conversation not found/.test(error.message)
        ) {
          throw missingConversationError(target.conversationId);
        }
        throw error;
      }
      return await work(session);
    } finally {
      await session.close();
    }
  }

  /** 目标不在当前列表时，给目录发现一点时间产出完整快照，再判定不存在。 */
  private async requireConversation(
    session: PiWebSession,
    conversationId: string,
    signal: AbortSignal | undefined,
  ): Promise<ProjectConversation> {
    const find = () => session.projectSnapshot?.conversations.find(({ id }) => id === conversationId);
    const cached = find();
    if (cached) return cached;
    if (session.projectSnapshot?.coverage !== "complete") session.requestProjectRefresh();
    let found: ProjectConversation | null;
    try {
      found = await session.waitUntil(
        () => find() ?? (session.projectSnapshot?.coverage === "complete" ? null : undefined),
        { timeoutMs: LOOKUP_GRACE_MS, signal, what: "查找会话" },
      );
    } catch (error) {
      if (!(error instanceof PiWebBridgeError && error.code === "timeout")) throw error;
      found = null;
    }
    if (found === null) throw missingConversationError(conversationId);
    return found;
  }

  private readFocused(
    session: PiWebSession,
    cwd: string,
    lastItems: number,
  ): ConversationReadResult {
    const focus = session.focus;
    const snapshot = session.snapshotFor(focus);
    if (focus === undefined || snapshot === undefined) {
      throw new PiWebBridgeError("会话没有打开，无法读取历史", "command_failed");
    }
    const summary = session.projectSnapshot?.conversations.find(({ id }) => id === focus.conversationId);
    const role = snapshot.role ?? summary?.role;
    return {
      cwd,
      conversationId: focus.conversationId,
      title: summary?.name ?? summary?.autoTitlePreview ?? session.state?.conversationName,
      role: role === undefined
        ? undefined
        : { name: role.name, model: role.model, toolMode: role.toolMode },
      activeRun: session.state?.activeRun,
      pendingPrompts: snapshot.pendingPrompts.length,
      loopList: snapshot.loopList,
      items: snapshot.items.slice(-lastItems),
      lastReply: lastAgentReply(snapshot.items),
      totalItems: snapshot.items.length,
      omittedBefore: snapshot.window.omittedBefore || snapshot.items.length > lastItems,
    };
  }

  async listConversations(cwd: string | undefined, signal?: AbortSignal): Promise<ConversationListResult> {
    const resolved = this.resolveCwd(cwd);
    return this.withSession(resolved, { kind: "recent" }, signal, async (session) => {
      // 打开最近会话时只发送展示索引；请求一次完整发现，短时间拿不到就用现有结果。
      if (session.projectSnapshot?.coverage !== "complete") session.requestProjectRefresh();
      await session.waitUntil(
        () => session.projectSnapshot?.coverage === "complete" ? true : undefined,
        { timeoutMs: LOOKUP_GRACE_MS, signal, what: "完整会话列表" },
      ).catch((error: unknown) => {
        if (error instanceof PiWebBridgeError && error.code === "timeout") return;
        throw error;
      });
      const snapshot = session.projectSnapshot!;
      return {
        cwd: resolved,
        conversations: snapshot.conversations,
        truncated: snapshot.truncated,
      };
    });
  }

  async listRoles(cwd: string | undefined, signal?: AbortSignal): Promise<RoleTemplate[]> {
    return this.withSession(this.resolveCwd(cwd), { kind: "recent" }, signal, async (session) => session.roles!);
  }

  async readConversation(input: {
    cwd?: string;
    conversationId: string;
    lastItems: number;
    signal?: AbortSignal;
  }): Promise<ConversationReadResult> {
    const cwd = this.resolveCwd(input.cwd);
    return this.withSession(
      cwd,
      { kind: "open", conversationId: input.conversationId },
      input.signal,
      async (session) => this.readFocused(session, cwd, input.lastItems),
    );
  }

  private messageText(message: string): string {
    const trimmed = message.trim();
    if (!trimmed) throw new PiWebBridgeError("消息不能为空", "invalid_input");
    const text = `${CLAUDE_MESSAGE_PREFIX}${trimmed}`;
    if (text.length > MAX_PROMPT_CHARACTERS) {
      throw new PiWebBridgeError(
        `消息过长：最多 ${MAX_PROMPT_CHARACTERS} 个字符（含前缀）`,
        "invalid_input",
      );
    }
    return text;
  }

  async createConversation(input: {
    cwd?: string;
    roleId: string;
    title?: string;
    task: string;
    signal?: AbortSignal;
  }): Promise<SendResult & { title: string | undefined }> {
    const cwd = this.resolveCwd(input.cwd);
    const text = this.messageText(input.task);
    const title = input.title?.trim()
      ? [...input.title.trim()].slice(0, MAX_PROJECT_CONVERSATION_NAME_CHARACTERS).join("")
      : undefined;
    return this.withSession(
      cwd,
      { kind: "new", roleId: input.roleId },
      input.signal,
      async (session) => {
        const conversationId = session.focus?.conversationId;
        if (conversationId === undefined) {
          throw new PiWebBridgeError("Pi Web 没有返回新会话", "command_failed");
        }
        if (title !== undefined) {
          await session.renameConversation(conversationId, title, this.commandTimeoutMs, input.signal);
        }
        const ack = await session.prompt(text, this.commandTimeoutMs, input.signal);
        return { cwd, conversationId, ack, title };
      },
    );
  }

  async sendMessage(input: {
    cwd?: string;
    conversationId: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<SendResult> {
    const cwd = this.resolveCwd(input.cwd);
    const text = this.messageText(input.message);
    return this.withSession(
      cwd,
      { kind: "open", conversationId: input.conversationId },
      input.signal,
      async (session) => ({
        cwd,
        conversationId: input.conversationId,
        ack: await session.prompt(text, this.commandTimeoutMs, input.signal),
      }),
    );
  }

  async waitForConversations(input: {
    cwd?: string;
    conversationIds: string[];
    timeoutMs: number;
    lastItems: number;
    signal?: AbortSignal;
  }): Promise<WaitResult> {
    const cwd = this.resolveCwd(input.cwd);
    const targets = [...new Set(input.conversationIds)];
    const targetSet = new Set(targets);
    return this.withSession(cwd, { kind: "recent" }, input.signal, async (session) => {
      for (const id of targets) await this.requireConversation(session, id, input.signal);
      const idleTarget = () => targets.find((id) => {
        const summary = session.projectSnapshot?.conversations.find((conversation) => conversation.id === id);
        return summary !== undefined && !isBusy(summary.activity);
      });
      const alreadyIdle = idleTarget();
      if (alreadyIdle !== undefined) {
        await session.focusConversation(alreadyIdle, this.commandTimeoutMs, input.signal);
        return {
          kind: "idle",
          conversationId: alreadyIdle,
          after: this.readFocused(session, cwd, input.lastItems),
        };
      }
      // 列表里的“空闲”可能早于结算事件发布，所以空闲后再给结算一个短暂宽限，
      // 只有始终等不到结算（例如 actor 异常结束）才按空闲返回。
      let idleSince: number | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const finished = session.waitUntil<{ settlement?: RunSettlement; idle?: string }>((event) => {
        if (
          event?.type === "conversation_run_settled"
          && event.sessionId === session.sessionId
          && targetSet.has(event.conversationId)
        ) {
          return { settlement: event };
        }
        const idle = idleTarget();
        if (idle === undefined) {
          idleSince = undefined;
          return undefined;
        }
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= IDLE_SETTLEMENT_GRACE_MS) return { idle };
        graceTimer ??= setTimeout(() => {
          graceTimer = undefined;
          session.poke();
        }, IDLE_SETTLEMENT_GRACE_MS);
        return undefined;
      }, { timeoutMs: input.timeoutMs, signal: input.signal, what: "会话本轮结束" });
      finished.catch(() => undefined).finally(() => clearTimeout(graceTimer));
      let outcome: { settlement?: RunSettlement; idle?: string };
      try {
        outcome = await finished;
      } catch (error) {
        if (error instanceof PiWebBridgeError && error.code === "timeout") {
          return {
            kind: "timeout",
            activities: targets.map((conversationId) => ({
              conversationId,
              activity: session.conversationActivity(conversationId),
            })),
          };
        }
        throw error;
      }
      const conversationId = outcome.settlement?.conversationId ?? outcome.idle!;
      // 重新聚焦取得结算之后的新快照；已聚焦时也重新附着，避免读到结算前的旧快照。
      await session.focusConversation(conversationId, this.commandTimeoutMs, input.signal, true);
      const after = this.readFocused(session, cwd, input.lastItems);
      if (outcome.settlement === undefined) return { kind: "idle", conversationId, after };
      return {
        kind: "settled",
        settlement: outcome.settlement,
        after,
        others: targets
          .filter((id) => id !== conversationId)
          .map((id) => ({ conversationId: id, activity: session.conversationActivity(id) })),
      };
    });
  }

  async abort(input: { cwd?: string; conversationId: string; signal?: AbortSignal }): Promise<AbortResult> {
    const cwd = this.resolveCwd(input.cwd);
    return this.withSession(
      cwd,
      { kind: "open", conversationId: input.conversationId },
      input.signal,
      async (session) => {
        const run = session.state?.activeRun;
        if (run === undefined) return { kind: "idle" };
        const settled = session.waitUntil((event) => {
          if (event?.type === "error" && event.operation === "abort" && event.runId === run.id) {
            throw new PiWebBridgeError(`Pi Web 停止失败：${event.message}`, "command_failed");
          }
          return event?.type === "conversation_run_settled" && event.runId === run.id
            ? event.outcome
            : undefined;
        }, { timeoutMs: ABORT_SETTLE_TIMEOUT_MS, signal: input.signal, what: "会话停止" });
        session.sendAbort(run.id);
        try {
          return { kind: "aborted", runId: run.id, outcome: await settled };
        } catch (error) {
          if (error instanceof PiWebBridgeError && error.code === "timeout") {
            return { kind: "aborted", runId: run.id, outcome: "unknown" };
          }
          throw error;
        }
      },
    );
  }
}
