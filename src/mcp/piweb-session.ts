import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  MAX_SERVER_EVENT_BYTES,
  PROTOCOL_VERSION,
  parseClientCommand,
  parseServerEvent,
  type ClientCommand,
  type ConversationActivity,
  type ExtensionUIRequest,
  type PublicState,
  type RoleTemplate,
  type ServerEvent,
} from "../shared/protocol.js";

export type BridgeErrorCode =
  | "unreachable"
  | "protocol_mismatch"
  | "dialog"
  | "timeout"
  | "closed"
  | "command_failed"
  | "cancelled"
  | "invalid_input";

export class PiWebBridgeError extends Error {
  constructor(message: string, readonly code: BridgeErrorCode) {
    super(message);
    this.name = "PiWebBridgeError";
  }
}

export type ProjectSnapshot = Extract<ServerEvent, { type: "project_snapshot" }>;
export type ConversationSnapshot = Extract<ServerEvent, { type: "conversation_snapshot" }>;
export type RunSettlement = Extract<ServerEvent, { type: "conversation_run_settled" }>;
export type InitializeTarget = Extract<ClientCommand, { type: "initialize" }>["conversation"];

export interface PromptAck {
  /** started：会话空闲，开始了新一轮；admitted：会话忙，消息已持久接收并归入该轮。 */
  readonly kind: "started" | "admitted";
  readonly runId: string;
}

interface Focus {
  readonly conversationId: string;
  readonly focusId: string;
}

interface Waiter {
  check(event: ServerEvent | undefined): unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export interface WaitOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** 超时与取消提示里说明正在等什么。 */
  readonly what: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;
const DEBUG = process.env.PIWEB_MCP_DEBUG === "1";

/** 调试时把收发帧的类型与关联身份写到 stderr；stdout 属于 MCP 协议。 */
function debugFrame(direction: "->" | "<-", frame: ClientCommand | ServerEvent): void {
  if (!DEBUG) return;
  const identity = Object.entries(frame)
    .filter(([key]) => ["commandId", "sessionId", "conversationId", "focusId", "runId", "promptId", "operation", "message"].includes(key))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const nested = frame.type === "session_event" ? ` event=${frame.event.type}` : "";
  console.error(`[piweb-mcp] ${direction} ${frame.type}${nested} ${identity}`);
}

/** 只允许本机地址：工作台只监听 loopback，桥不能把会话控制扩展到远程。 */
export function resolvePiWebUrl(value: string | undefined): URL {
  const url = new URL(value?.trim() || "http://127.0.0.1:31415");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PiWebBridgeError(`PIWEB_URL 必须是 http(s) 地址：${url.href}`, "invalid_input");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new PiWebBridgeError(`PIWEB_URL 只能指向本机：${url.href}`, "invalid_input");
  }
  return new URL(url.origin);
}

function dialogDescription(request: ExtensionUIRequest): string {
  switch (request.kind) {
    case "select":
      return `选择框「${request.title}」，选项：${request.options.join(" / ")}`;
    case "confirm":
      return `确认框「${request.title}」：${request.message}`;
    case "input":
      return `输入框「${request.title}」`;
    case "editor":
      return `编辑框「${request.title}」`;
  }
}

/**
 * 一条到 Pi Web 的短连接，等同于一个只做一件事的浏览器标签页。
 *
 * 它按浏览器相同的顺序握手、关联身份并用共享协议 schema 校验每一帧。
 * initialize 声明 `extensionUi: "none"`：服务端不把扩展对话框或通知发给它，
 * 不因它询问项目信任，也不让它改动最近会话。万一仍收到对话框，
 * 立即断开让服务端按取消结算，并把对话框内容报告给调用方，由用户决定。
 */
export class PiWebSession {
  readonly sessionId = randomUUID();
  projectId: string | undefined;
  focus: Focus | undefined;
  state: PublicState | undefined;
  projectSnapshot: ProjectSnapshot | undefined;
  roles: RoleTemplate[] | undefined;
  private readonly snapshots = new Map<string, ConversationSnapshot>();
  private readonly waiters = new Set<Waiter>();
  private failure: PiWebBridgeError | undefined;
  private closed = false;
  private helloSeen = false;
  private readonly hello: Promise<void>;
  private resolveHello!: () => void;
  private rejectHello!: (error: unknown) => void;

  private constructor(
    private readonly socket: WebSocket,
    private readonly origin: string,
  ) {
    this.hello = new Promise<void>((resolve, reject) => {
      this.resolveHello = resolve;
      this.rejectHello = reject;
    });
    this.hello.catch(() => undefined);
    // 同一 TCP 块里的多帧会被同步连续派发，所以从第一帧起就由同一个处理器接收。
    socket.on("message", (data, isBinary) => this.onFrame(data, isBinary));
    socket.on("close", (code, reason) => {
      this.closed = true;
      this.fail(this.helloSeen
        ? new PiWebBridgeError(
            `Pi Web 连接已断开（${code}${reason.length > 0 ? ` ${reason.toString("utf8")}` : ""}）`,
            "closed",
          )
        : this.unreachable(`连接在握手前关闭（${code}）`));
    });
    socket.on("error", (error) => {
      this.fail(this.helloSeen
        ? new PiWebBridgeError(`Pi Web 连接出错：${error.message}`, "closed")
        : this.unreachable(error.message));
    });
  }

  static async connect(baseUrl: URL, signal?: AbortSignal): Promise<PiWebSession> {
    if (signal?.aborted) throw new PiWebBridgeError("调用已取消", "cancelled");
    const wsUrl = new URL("/ws", baseUrl);
    wsUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
    const session = new PiWebSession(
      new WebSocket(wsUrl, {
        origin: baseUrl.origin,
        maxPayload: MAX_SERVER_EVENT_BYTES,
      }),
      baseUrl.origin,
    );
    const timer = setTimeout(
      () => session.fail(session.unreachable("握手超时")),
      CONNECT_TIMEOUT_MS,
    );
    const abort = () => session.fail(new PiWebBridgeError("调用已取消", "cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await session.hello;
    } catch (error) {
      session.socket.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    return session;
  }

  private unreachable(detail: string): PiWebBridgeError {
    return new PiWebBridgeError(
      `无法连接 Pi Web（${this.origin}）：${detail}。Pi Web 可能没有运行；征得用户同意后可以调用 piweb_start 启动。`,
      "unreachable",
    );
  }

  private onFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.failure) return;
    let event: ServerEvent;
    try {
      if (isBinary) throw new Error("binary frame");
      event = parseServerEvent(data.toString("utf8"));
    } catch (error) {
      this.fail(new PiWebBridgeError(
        `收到无法识别的服务端事件，协议可能已升级：${error instanceof Error ? error.message : String(error)}`,
        "protocol_mismatch",
      ));
      this.socket.terminate();
      return;
    }
    debugFrame("<-", event);
    if (!this.helloSeen) {
      if (event.type !== "hello") {
        this.fail(new PiWebBridgeError(`握手首帧应为 hello，实际为 ${event.type}`, "protocol_mismatch"));
        this.socket.terminate();
        return;
      }
      if (event.protocolVersion !== PROTOCOL_VERSION) {
        this.fail(new PiWebBridgeError(
          `协议版本不一致：Pi Web 服务端为 ${event.protocolVersion}，本桥为 ${PROTOCOL_VERSION}。请让两边都用同一份代码重新构建（npm run build），再重启 Pi Web 或重连 MCP。`,
          "protocol_mismatch",
        ));
        this.socket.terminate();
        return;
      }
      this.helloSeen = true;
      this.resolveHello();
      return;
    }
    this.observe(event);
  }

  private observe(event: ServerEvent): void {
    // Browser-only previews and Git observations never enter an MCP waiter.
    if (
      event.type === "local_file" || event.type === "local_image" || event.type === "conversation_image"
      || event.type === "workspace_changes"
    ) return;
    if (event.type === "extension_ui_request") {
      const conversation = this.focus === undefined
        ? ""
        : `（会话 ${this.focus.conversationId}）`;
      this.fail(new PiWebBridgeError(
        `Pi Web 弹出了需要用户回答的${dialogDescription(event.request)}${conversation}。本桥不会替用户作答，已断开连接，服务端会按“取消”处理，不会保存任何选择。请把这个对话框告诉用户，由用户在浏览器中处理后再继续。`,
        "dialog",
      ));
      this.socket.terminate();
      return;
    }
    if ("sessionId" in event && event.sessionId === this.sessionId) {
      switch (event.type) {
        case "project_snapshot":
          this.projectSnapshot = event;
          break;
        case "role_catalog_snapshot":
          this.roles = event.roles;
          break;
        case "focus_attached":
          this.projectId = event.projectId;
          this.focus = event.conversationId === undefined || event.focusId === undefined
            ? undefined
            : { conversationId: event.conversationId, focusId: event.focusId };
          break;
        case "focus_invalidated":
          if (this.focus?.focusId === event.focusId) this.focus = undefined;
          break;
        case "conversation_snapshot":
          this.snapshots.set(event.focusId, event);
          break;
        default:
          break;
      }
    }
    if (event.type === "state" && event.state.sessionId === this.sessionId) {
      this.state = event.state;
    }
    if (event.type === "error" && event.scope === "protocol") {
      this.fail(new PiWebBridgeError(`Pi Web 拒绝了本桥的命令：${event.message}`, "command_failed"));
      return;
    }
    for (const waiter of [...this.waiters]) this.evaluate(waiter, event);
  }

  private evaluate(waiter: Waiter, event: ServerEvent | undefined): void {
    let value: unknown;
    try {
      value = waiter.check(event);
    } catch (error) {
      this.waiters.delete(waiter);
      waiter.reject(error);
      return;
    }
    if (value !== undefined) {
      this.waiters.delete(waiter);
      waiter.resolve(value);
    }
  }

  private fail(error: PiWebBridgeError): void {
    this.failure ??= error;
    this.rejectHello(this.failure);
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.reject(this.failure);
    }
  }

  /**
   * 等到 check 返回非 undefined。check 先对当前状态求值一次（event 为 undefined），
   * 之后每收到一帧再求值。必须在发送命令前调用，避免错过回执。
   */
  waitUntil<T>(
    check: (event: ServerEvent | undefined) => T | undefined,
    options: WaitOptions,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        check,
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        if (!this.waiters.delete(waiter)) return;
        waiter.reject(new PiWebBridgeError(`调用已取消：${options.what}`, "cancelled"));
      };
      if (options.signal?.aborted) {
        reject(new PiWebBridgeError(`调用已取消：${options.what}`, "cancelled"));
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (!this.waiters.delete(waiter)) return;
        waiter.reject(new PiWebBridgeError(`等待超时：${options.what}`, "timeout"));
      }, options.timeoutMs);
      this.waiters.add(waiter);
      this.evaluate(waiter, undefined);
    });
  }

  /** 不等新帧，按当前状态重新评估全部等待条件（供基于时间的条件使用）。 */
  poke(): void {
    for (const waiter of [...this.waiters]) this.evaluate(waiter, undefined);
  }

  send(command: ClientCommand): void {
    if (this.failure) throw this.failure;
    let validated: ClientCommand;
    try {
      validated = parseClientCommand(command);
    } catch (error) {
      throw new PiWebBridgeError(
        `命令不符合协议：${error instanceof Error ? error.message : String(error)}`,
        "invalid_input",
      );
    }
    debugFrame("->", validated);
    this.socket.send(JSON.stringify(validated));
  }

  private commandError(
    event: ServerEvent | undefined,
    commandId: string,
    operation: string,
  ): void {
    if (
      event?.type === "error"
      && (event.commandId === commandId
        || (event.commandId === undefined
          && event.operation === operation
          && event.sessionId === this.sessionId))
    ) {
      throw new PiWebBridgeError(`Pi Web 执行 ${operation} 失败：${event.message}`, "command_failed");
    }
  }

  snapshotFor(focus: Focus | undefined): ConversationSnapshot | undefined {
    return focus === undefined ? undefined : this.snapshots.get(focus.focusId);
  }

  /**
   * 焦点会话的权威 activeRun 与历史都已到达后返回。focus_attached 之后的
   * 发布仍可能以同一 commandId 报错，所以继续检查该命令的错误。
   */
  private focusReady(
    commandId: string,
    operation: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return this.waitUntil((event) => {
      this.commandError(event, commandId, operation);
      const focus = this.focus;
      if (focus === undefined) return true;
      return this.snapshots.has(focus.focusId) && this.state?.focusId === focus.focusId
        ? true
        : undefined;
    }, { timeoutMs, signal, what: "会话历史快照" }).then(() => undefined);
  }

  async initialize(
    cwd: string,
    conversation: InitializeTarget,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const commandId = randomUUID();
    const attached = this.waitUntil((event) => {
      this.commandError(event, commandId, "initialize");
      return event?.type === "focus_attached" && event.commandId === commandId
        ? true
        : undefined;
    }, { timeoutMs, signal, what: "打开项目" });
    this.send({
      type: "initialize",
      commandId,
      sessionId: this.sessionId,
      cwd,
      conversation,
      extensionUi: "none",
    });
    await attached;
    await this.waitUntil((event) => {
      this.commandError(event, commandId, "initialize");
      return this.projectSnapshot !== undefined && this.roles !== undefined ? true : undefined;
    }, { timeoutMs, signal, what: "项目会话列表" });
    await this.focusReady(commandId, "initialize", timeoutMs, signal);
  }

  async focusConversation(
    conversationId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<void> {
    if (!refresh && this.focus?.conversationId === conversationId) return;
    const commandId = randomUUID();
    const attached = this.waitUntil((event) => {
      this.commandError(event, commandId, "focus_conversation");
      return event?.type === "focus_attached" && event.commandId === commandId
        ? true
        : undefined;
    }, { timeoutMs, signal, what: "切换会话" });
    this.send({
      type: "focus_conversation",
      commandId,
      sessionId: this.sessionId,
      conversationId,
    });
    await attached;
    await this.focusReady(commandId, "focus_conversation", timeoutMs, signal);
  }

  async renameConversation(
    conversationId: string,
    name: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const commandId = randomUUID();
    const done = this.waitUntil((event) => {
      this.commandError(event, commandId, "rename_conversation");
      return event?.type === "command_complete" && event.commandId === commandId
        ? true
        : undefined;
    }, { timeoutMs, signal, what: "设置会话名称" });
    this.send({
      type: "rename_conversation",
      commandId,
      sessionId: this.sessionId,
      conversationId,
      name,
    });
    await done;
  }

  async prompt(text: string, timeoutMs: number, signal?: AbortSignal): Promise<PromptAck> {
    const focus = this.focus;
    if (focus === undefined) {
      throw new PiWebBridgeError("没有已打开的会话，无法发送消息", "invalid_input");
    }
    const runId = randomUUID();
    const promptId = randomUUID();
    const ack = this.waitUntil<PromptAck>((event) => {
      if (
        event?.type === "error"
        && event.operation === "prompt"
        && event.runId === runId
      ) {
        throw new PiWebBridgeError(`Pi Web 拒绝了消息：${event.message}`, "command_failed");
      }
      if (
        event?.type === "session_event"
        && event.focusId === focus.focusId
        && event.runId === runId
        && event.event.type === "run_queued"
      ) {
        return { kind: "started", runId };
      }
      if (
        event?.type === "prompt_admitted"
        && event.focusId === focus.focusId
        && event.promptId === promptId
      ) {
        return { kind: "admitted", runId: event.runId };
      }
      return undefined;
    }, { timeoutMs, signal, what: "Pi Web 确认收到消息" });
    this.send({
      type: "prompt",
      sessionId: this.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      runId,
      promptId,
      text,
    });
    return ack;
  }

  sendAbort(runId: string): void {
    const focus = this.focus;
    if (focus === undefined) {
      throw new PiWebBridgeError("没有已打开的会话，无法停止", "invalid_input");
    }
    this.send({
      type: "abort",
      sessionId: this.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      runId,
    });
  }

  /** 请服务端重新发现项目会话；结果以 coverage=complete 的 project_snapshot 到达。 */
  requestProjectRefresh(): void {
    if (this.projectId === undefined) return;
    this.send({
      type: "refresh_view",
      sessionId: this.sessionId,
      projectId: this.projectId,
      ...(this.focus === undefined
        ? {}
        : { conversationId: this.focus.conversationId, focusId: this.focus.focusId }),
    });
  }

  conversationActivity(conversationId: string): ConversationActivity | undefined {
    return this.projectSnapshot?.conversations.find(({ id }) => id === conversationId)?.activity;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, CLOSE_TIMEOUT_MS);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.socket.close();
    await closed;
  }
}
