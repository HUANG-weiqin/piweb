import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type ServerEvent,
} from "../shared/protocol.js";
import {
  FakeRuntime,
  agentMessage,
  deferred,
  type FakeSessionControl,
  type SessionBehavior,
} from "../server/coordinator-test-fixture.js";
import { RoleCatalog } from "../server/role-catalog.js";
import { attachSocketServer } from "../server/socket-server.js";
import { CLAUDE_MESSAGE_PREFIX } from "./conversation-text.js";
import { PiWebBridge } from "./piweb-bridge.js";
import { PiWebBridgeError, PiWebSession, resolvePiWebUrl } from "./piweb-session.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/** 与 Pi 相同：先发 raw user message_end，再由同一 SessionManager 落盘（宿主据此写投递标记）。 */
function deliverUser(control: FakeSessionControl, message: ReturnType<typeof agentMessage>): void {
  control.listener?.({ type: "message_end", message } as never);
  control.manager.appendMessage(message);
}

function deliverUserMessages(control: FakeSessionControl, initial: string | undefined): void {
  if (initial !== undefined) {
    deliverUser(control, agentMessage({ role: "user", content: initial, timestamp: Date.now() }));
  }
  control.steeringMessages.splice(0);
  for (const message of control.steeringAgentMessages.splice(0)) deliverUser(control, message);
}

function reply(control: FakeSessionControl, text: string): void {
  const message = agentMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test",
    model: "model-a",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  control.listener?.({ type: "message_start", message } as never);
  control.listener?.({ type: "message_end", message } as never);
  control.manager.appendMessage(message);
}

/** 像真实 Pi 一样先落盘用户原文，再回复。 */
function repliesWith(text: string): SessionBehavior {
  return async (control) => {
    deliverUserMessages(control, control.promptTexts.at(-1));
    reply(control, text);
  };
}

/** 运行到 release 才结束；期间被 steer 的用户消息在结束前投递。 */
function holdsUntil(
  started: { resolve(): void },
  release: { promise: Promise<void>; resolve(): void },
  text: string,
): SessionBehavior {
  return async (control) => {
    deliverUserMessages(control, control.promptTexts.at(-1));
    control.abortCurrent = () => release.resolve();
    started.resolve();
    await release.promise;
    deliverUserMessages(control, undefined);
    reply(control, text);
  };
}

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return new URL(`http://127.0.0.1:${address.port}`);
}

async function piWebHarness() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "piweb-mcp-")));
  const runtime = new FakeRuntime();
  // PiConnection 发布 PublicState 时需要的模型目录面，与 pi-service 测试的桩一致。
  Object.assign(runtime.modelRuntime, {
    getProviders: () => [],
    getProvider: () => undefined,
  });
  Object.assign(runtime.modelRegistry, {
    getAll: () => runtime.availableModels,
    getRegisteredProviderIds: () => [],
    getError: () => undefined,
    getProviderDisplayName: (provider: string) => provider,
    getProviderAuthStatus: () => ({ configured: true }),
    hasConfiguredAuth: () => true,
  });
  const createSession = runtime.createSession.bind(runtime);
  runtime.createSession = async (sessionCwd, options) => {
    const created = await createSession(sessionCwd, options);
    Object.assign(created.session, {
      getAvailableThinkingLevels: () => ["off"],
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        contextUsage: undefined,
      }),
    });
    return created;
  };
  const originalOpen = RoleCatalog.open;
  vi.spyOn(RoleCatalog, "open").mockImplementation((source) =>
    originalOpen(source, join(cwd, "user", "roles.json")));
  const server = createServer();
  const socketServer = attachSocketServer(server, cwd, runtime);
  const baseUrl = await listen(server);
  cleanups.push(async () => {
    await socketServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  });
  const bridge = new PiWebBridge({ baseUrl, defaultCwd: cwd, commandTimeoutMs: 5_000 });
  return { cwd, runtime, bridge };
}

describe("PiWebBridge against a real Pi Web socket server", () => {
  it("creates a conversation, waits for its reply, follows up and reads history", async () => {
    const { runtime, bridge } = await piWebHarness();
    runtime.nextSessionBehaviors.push([
      repliesWith("第一轮完成"),
      repliesWith("第二轮完成"),
    ]);

    const roles = await bridge.listRoles(undefined);
    expect(roles.map(({ id }) => id)).toContain("default");

    const created = await bridge.createConversation({
      roleId: "default",
      title: "桥接测试",
      task: "写一个函数",
    });
    expect(created.ack.kind).toBe("started");
    const conversationId = created.conversationId;
    expect(runtime.control(conversationId).promptTexts[0]).toBe(`${CLAUDE_MESSAGE_PREFIX}写一个函数`);

    const first = await bridge.waitForConversations({
      conversationIds: [conversationId],
      timeoutMs: 5_000,
      lastItems: 8,
    });
    expect(first.kind === "settled" || first.kind === "idle").toBe(true);
    if (first.kind === "timeout") throw new Error("unexpected timeout");
    expect(first.after.lastReply).toBe("第一轮完成");
    expect(first.after.activeRun).toBeUndefined();

    const sent = await bridge.sendMessage({ conversationId, message: "继续" });
    expect(sent.ack.kind).toBe("started");
    const second = await bridge.waitForConversations({
      conversationIds: [conversationId],
      timeoutMs: 5_000,
      lastItems: 8,
    });
    if (second.kind === "timeout") throw new Error("unexpected timeout");
    expect(second.after.lastReply).toBe("第二轮完成");

    const read = await bridge.readConversation({ conversationId, lastItems: 10 });
    const messages = read.items.flatMap((item) =>
      item.kind === "message" ? [`${item.role}:${item.text}`] : []);
    expect(messages).toEqual([
      `user:${CLAUDE_MESSAGE_PREFIX}写一个函数`,
      "assistant:第一轮完成",
      `user:${CLAUDE_MESSAGE_PREFIX}继续`,
      "assistant:第二轮完成",
    ]);
    expect(read.pendingPrompts).toBe(0);

    const listed = await bridge.listConversations(undefined);
    expect(listed.conversations).toContainEqual(expect.objectContaining({
      id: conversationId,
      name: "桥接测试",
    }));
  });

  it("waits for a busy conversation, admits a busy message, and returns after settlement", async () => {
    const { runtime, bridge } = await piWebHarness();
    const started = deferred();
    const release = deferred();
    runtime.nextSessionBehaviors.push([repliesWith("空闲会话完成")]);
    const idle = await bridge.createConversation({ roleId: "default", task: "空闲任务" });
    runtime.nextSessionBehaviors.push([holdsUntil(started, release, "长任务完成")]);
    const busy = await bridge.createConversation({ roleId: "default", task: "长任务" });
    await started.promise;
    await bridge.waitForConversations({
      conversationIds: [idle.conversationId],
      timeoutMs: 5_000,
      lastItems: 4,
    });

    const steered = await bridge.sendMessage({
      conversationId: busy.conversationId,
      message: "顺便补充一点",
    });
    expect(steered.ack).toEqual({ kind: "admitted", runId: busy.ack.runId });

    let settled = false;
    const waiting = bridge.waitForConversations({
      conversationIds: [busy.conversationId],
      timeoutMs: 5_000,
      lastItems: 8,
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    release.resolve();
    const result = await waiting;
    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") throw new Error("expected settlement");
    expect(result.settlement).toMatchObject({
      conversationId: busy.conversationId,
      runId: busy.ack.runId,
      outcome: "completed",
    });
    expect(result.after.lastReply).toBe("长任务完成");
    expect(result.after.items.flatMap((item) =>
      item.kind === "message" && item.role === "user" ? [item.text] : [])).toContain(
      `${CLAUDE_MESSAGE_PREFIX}顺便补充一点`,
    );
  });

  it("reports a timeout without failing while the conversation keeps running", async () => {
    const { runtime, bridge } = await piWebHarness();
    const started = deferred();
    const release = deferred();
    runtime.nextSessionBehaviors.push([holdsUntil(started, release, "done")]);
    const busy = await bridge.createConversation({ roleId: "default", task: "慢任务" });
    await started.promise;
    const result = await bridge.waitForConversations({
      conversationIds: [busy.conversationId],
      timeoutMs: 300,
      lastItems: 4,
    });
    expect(result).toMatchObject({
      kind: "timeout",
      activities: [{ conversationId: busy.conversationId, activity: { runId: busy.ack.runId } }],
    });
    release.resolve();
  });

  it("aborts the active run and reports an idle conversation as idle", async () => {
    const { runtime, bridge } = await piWebHarness();
    const started = deferred();
    const release = deferred();
    runtime.nextSessionBehaviors.push([holdsUntil(started, release, "被停止")]);
    const busy = await bridge.createConversation({ roleId: "default", task: "可停止任务" });
    await started.promise;

    const aborted = await bridge.abort({ conversationId: busy.conversationId });
    expect(aborted).toEqual({ kind: "aborted", runId: busy.ack.runId, outcome: "aborted" });
    expect(runtime.control(busy.conversationId).abortCalls).toBeGreaterThan(0);
    await expect(bridge.abort({ conversationId: busy.conversationId }))
      .resolves.toEqual({ kind: "idle" });
  });

  it("reads a conversation without taking over its pending extension dialog", async () => {
    const { runtime, bridge } = await piWebHarness();
    runtime.nextSessionBehaviors.push([repliesWith("完成")]);
    const created = await bridge.createConversation({ roleId: "default", task: "任务" });
    await bridge.waitForConversations({
      conversationIds: [created.conversationId],
      timeoutMs: 5_000,
      lastItems: 4,
    });
    const ui = runtime.createOptions.get(created.conversationId)?.extensionUI;
    if (!ui) throw new Error("conversation extension UI was not bound");
    let answered = false;
    const dialog = ui.confirm("等待用户", "只有浏览器可以回答").then((value) => {
      answered = true;
      return value;
    });

    const read = await bridge.readConversation({
      conversationId: created.conversationId,
      lastItems: 4,
    });
    expect(read.lastReply).toBe("完成");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    void dialog;
  });

  it("rejects unknown conversations and empty messages before touching history", async () => {
    const { bridge } = await piWebHarness();
    await expect(bridge.waitForConversations({
      conversationIds: ["missing-conversation"],
      timeoutMs: 1_000,
      lastItems: 4,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(bridge.sendMessage({ conversationId: "whatever", message: "   " }))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("explains a missing conversation in Chinese instead of the raw server error", async () => {
    const { bridge } = await piWebHarness();
    const missing = "missing-conversation";
    const sent = await bridge.sendMessage({ conversationId: missing, message: "不应送达" })
      .catch((error: unknown) => error);
    expect(sent).toBeInstanceOf(PiWebBridgeError);
    expect(sent).toMatchObject({ code: "invalid_input" });
    expect((sent as Error).message).toBe(
      `项目里找不到会话 ${missing}。可先用 piweb_list_conversations 查看。`,
    );
    await expect(bridge.readConversation({ conversationId: missing, lastItems: 4 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(bridge.abort({ conversationId: missing }))
      .rejects.toMatchObject({ code: "invalid_input" });
  });
});

async function fakePiWeb(
  onCommand: (command: ClientCommand, send: (event: ServerEvent) => void) => void,
  protocolVersion = PROTOCOL_VERSION,
) {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: request.url === "/health" }));
  });
  const sockets = new WebSocketServer({ server, path: "/ws" });
  const received: ClientCommand[] = [];
  const closed = deferred();
  sockets.on("connection", (socket) => {
    const send = (event: ServerEvent) => socket.send(JSON.stringify(event));
    send({
      type: "hello",
      protocolVersion,
      startupCwd: "E:\\work",
      uiPreferences: { colorScheme: "quiet-rebel" },
    } as ServerEvent);
    socket.on("message", (data) => {
      const command = JSON.parse(data.toString("utf8")) as ClientCommand;
      received.push(command);
      onCommand(command, send);
    });
    socket.on("close", () => closed.resolve());
  });
  const baseUrl = await listen(server);
  cleanups.push(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl, received, closed: closed.promise };
}

describe("PiWebBridge safety boundaries", () => {
  it("accepts the current protocol but ignores browser-only file/image bytes and workspace changes", async () => {
    const { baseUrl } = await fakePiWeb((command, send) => {
      if (command.type !== "refresh_view") return;
      send({
        type: "local_image", sessionId: command.sessionId,
        conversationId: randomUUID(), focusId: randomUUID(), commandId: randomUUID(),
        path: "E:/a.png", mimeType: "image/png", data: "iVBORw0KGgo=",
      });
      send({
        type: "local_file", sessionId: command.sessionId,
        conversationId: randomUUID(), focusId: randomUUID(), commandId: randomUUID(),
        path: "E:/report.md", fileName: "report.md", mimeType: "text/plain", data: "",
      });
      send({
        type: "workspace_changes", sessionId: command.sessionId,
        projectId: command.projectId, commandId: randomUUID(),
        snapshot: { state: "ready", branch: "main", files: [], total: 0, truncated: false },
      });
      send({ type: "project_snapshot", sessionId: command.sessionId, projectId: command.projectId,
        conversations: [], truncated: false, coverage: "complete" });
    });
    const session = await PiWebSession.connect(baseUrl);
    try {
      const check = vi.fn((event: ServerEvent | undefined) => event?.type === "project_snapshot" ? true : undefined);
      const waiting = session.waitUntil(check, { timeoutMs: 2_000, what: "project snapshot" });
      session.send({ type: "refresh_view", sessionId: session.sessionId, projectId: randomUUID() });
      await expect(waiting).resolves.toBe(true);
      expect(check.mock.calls.some(([event]) => event?.type === "local_image")).toBe(false);
      expect(check.mock.calls.some(([event]) => event?.type === "local_file")).toBe(false);
      expect(check.mock.calls.some(([event]) => event?.type === "workspace_changes")).toBe(false);
    } finally {
      await session.close();
    }
  });
  it("validates local file responses before ignoring them", async () => {
    const { baseUrl } = await fakePiWeb((command, send) => {
      if (command.type !== "refresh_view") return;
      send({
        type: "local_file", sessionId: command.sessionId,
        conversationId: randomUUID(), focusId: randomUUID(), commandId: randomUUID(),
        path: "report.md", fileName: "report.md", mimeType: "text/html", data: "",
      } as unknown as ServerEvent);
    });
    const session = await PiWebSession.connect(baseUrl);
    try {
      const waiting = session.waitUntil(() => undefined, { timeoutMs: 2_000, what: "project snapshot" });
      session.send({ type: "refresh_view", sessionId: session.sessionId, projectId: randomUUID() });
      await expect(waiting).rejects.toMatchObject({ code: "protocol_mismatch" });
    } finally {
      await session.close();
    }
  });

  it("refuses a Pi Web server that speaks a different protocol version", async () => {
    const { baseUrl, received } = await fakePiWeb(() => undefined, PROTOCOL_VERSION + 1);
    const bridge = new PiWebBridge({ baseUrl, defaultCwd: tmpdir(), commandTimeoutMs: 2_000 });
    await expect(bridge.listConversations(undefined)).rejects.toMatchObject({
      code: "protocol_mismatch",
    });
    expect(received).toEqual([]);
  });

  it("does not start a second Pi Web and reports an already running older version", async () => {
    const { baseUrl } = await fakePiWeb(() => undefined, PROTOCOL_VERSION - 1);
    const launch = vi.fn();
    const bridge = new PiWebBridge({
      baseUrl,
      defaultCwd: tmpdir(),
      repoRoot: process.cwd(),
      launcher: { launch },
    });
    const error = await bridge.start().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "protocol_mismatch" });
    expect((error as Error).message).toContain("Pi Web 已在运行");
    expect(launch).not.toHaveBeenCalled();
  });

  it("reports an already running Pi Web with the same version as already running", async () => {
    const { baseUrl } = await fakePiWeb(() => undefined);
    const launch = vi.fn();
    const bridge = new PiWebBridge({
      baseUrl,
      defaultCwd: tmpdir(),
      repoRoot: process.cwd(),
      launcher: { launch },
    });
    await expect(bridge.start()).resolves.toEqual({ kind: "already_running" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("never answers an extension dialog and disconnects so the server settles it", async () => {
    const { baseUrl, received, closed } = await fakePiWeb((command, send) => {
      if (command.type !== "initialize") return;
      send({
        type: "extension_ui_request",
        sessionId: command.sessionId,
        requestId: randomUUID(),
        request: { kind: "select", title: "是否信任项目资源？", options: ["信任", "不信任"] },
      });
    });
    const bridge = new PiWebBridge({ baseUrl, defaultCwd: tmpdir(), commandTimeoutMs: 2_000 });
    const error = await bridge.listConversations(undefined).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiWebBridgeError);
    expect(error).toMatchObject({ code: "dialog" });
    expect((error as Error).message).toContain("是否信任项目资源？");
    await closed;
    expect(received).toEqual([
      expect.objectContaining({ type: "initialize", extensionUi: "none" }),
    ]);
  });

  it("only accepts loopback Pi Web addresses", () => {
    expect(resolvePiWebUrl(undefined).href).toBe("http://127.0.0.1:31415/");
    expect(resolvePiWebUrl("http://localhost:4000/anything").href).toBe("http://localhost:4000/");
    expect(() => resolvePiWebUrl("http://192.168.1.2:31415")).toThrow(PiWebBridgeError);
    expect(() => resolvePiWebUrl("ftp://127.0.0.1")).toThrow(PiWebBridgeError);
  });
});
