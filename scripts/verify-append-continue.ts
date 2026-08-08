/**
 * 验证实验：宿主通过 SessionManager.appendMessage 落盘 user entry 后，
 * Agent 能否在下一轮读到（"直接落盘到 json 里不行吗"）。
 *
 * 场景 A：run 进行中（busy）宿主落盘 → run 结束后 rebuild → continue 是否可行
 * 场景 B：run 结束后宿主落盘 → rebuild → continue 是否可行
 *
 * 使用真实 pi-agent-core Agent + 假 streamFn（不调真实 LLM）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Agent } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";
import { AssistantMessageEventStream } from "../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";

const LOG: string[] = [];
function log(label: string, value: unknown): void {
  const line = `${label}: ${JSON.stringify(value)}`;
  LOG.push(line);
  console.log(line);
}

interface LlmCall {
  userTexts: string[];
  release: () => void;
}

/** 假 LLM：记录收到的 user 文本，可暂停（模拟 run 进行中），然后返回固定回复。 */
function makeFakeStreamFn(calls: LlmCall[]) {
  return async (_model: unknown, context: { messages: Array<{ role: string; content: unknown }> }) => {
    const userTexts = context.messages
      .filter((m) => m.role === "user")
      .map((m) => Array.isArray(m.content)
        ? m.content.map((c: { text?: string }) => c.text ?? "?").join("")
        : String(m.content));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    console.log("[streamFn] called, users:", JSON.stringify(userTexts));
    calls.push({ userTexts, release });
    console.log("[streamFn] waiting gate...");
    await gate; // 等测试释放（模拟 run 进行中宿主写消息）
    console.log("[streamFn] gate released");
    const stream = new AssistantMessageEventStream();
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: `A:${userTexts.join(",")}` }],
      api: "fake",
      provider: "fake",
      model: "fake",
      usage: {},
      stopReason: "stop",
      timestamp: Date.now(),
    } as never;
    stream.push({ type: "start", partial: assistant } as never);
    stream.push({ type: "done", reason: "stop", message: assistant } as never);
    stream.end(assistant);
    return stream;
  };
}

function makeAgent(calls: LlmCall[], sm: SessionManager): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt: "",
      model: { id: "fake", provider: "fake", description: "fake", label: "fake", options: {} } as never,
      thinkingLevel: "off",
      tools: [],
    },
    streamFn: makeFakeStreamFn(calls),
    convertToLlm: (messages: unknown[]) => messages as never,
  });
  // 模拟 AgentSession._handleAgentEvent 的持久化：message_end → appendMessage
  agent.subscribe(async (event: { type: string; message?: { role: string } }) => {
    if (event.type === "message_end" && event.message) {
      const entryId = sm.appendMessage(event.message as never);
      log("  persist", `${event.message.role} -> ${entryId}`);
    }
  });
  return agent;
}

function inspect(label: string, sm: SessionManager, agent: Agent): void {
  log(`[${label}] entries`, sm.getEntries().map((e) =>
    `${e.type}:${e.message?.role ?? e.type}(${e.id.slice(0, 4)})[parent=${e.parentId ? e.parentId.slice(0, 4) : "root"}]`
  ));
  log(`[${label}] leaf`, sm.getLeafEntry()?.id.slice(0, 4));
  const ctx = sm.buildSessionContext();
  log(`[${label}] buildSessionContext roles`, ctx.messages.map((m) => m.role));
  log(`[${label}] agent.state.messages roles`, agent.state.messages.map((m) => m.role));
}

async function runScenarioA(): Promise<void> {
  LOG.push("===== 场景 A：busy 时宿主落盘（U1 在 run 中 append） =====");
  const dir = mkdtempSync(join(tmpdir(), "piweb-verify-a-"));
  const sm = SessionManager.create(dir);
  const calls: LlmCall[] = [];
  const agent = makeAgent(calls, sm);

  // 历史：先有一条 U0 + 回复 A0（第一轮 run）
  const p0 = agent.prompt([{ role: "user", content: [{ type: "text", text: "U0" }], timestamp: Date.now() }] as never);
  while (calls.length < 1) await new Promise((r) => setTimeout(r, 5));
  await calls[0]!.release(); // 释放第一个 LLM 调用
  await p0;
  inspect("after U0 run", sm, agent);

  // 第二轮 run：U1 作为 prompt（模拟当前 run），busy 期间宿主 append U2
  const p1 = agent.prompt([{ role: "user", content: [{ type: "text", text: "U1" }], timestamp: Date.now() }] as never);
  // 等 LLM 开始（busy 中）
  while (calls.length < 2) await new Promise((r) => setTimeout(r, 5));
  log("  [busy] LLM sees", calls[1]!.userTexts);
  // 宿主在 run 进行中通过 SessionManager API 落盘 U2
  const u2Id = sm.appendMessage({ role: "user", content: [{ type: "text", text: "U2" }], timestamp: Date.now() } as never);
  log("  [busy] host appended U2 ->", u2Id.slice(0, 4));
  inspect("busy mid-run", sm, agent);
  calls[1]!.release();
  await p1;
  inspect("after U1 run (U2 was appended mid-run)", sm, agent);

  // 宿主 rebuild（模拟 setSessionFile + buildSessionContext）
  agent.state.messages = sm.buildSessionContext().messages;
  log("  [after rebuild] last role", agent.state.messages.at(-1)?.role);
  // 尝试 continue
  try {
    const p2 = agent.continue();
    await p2;
    log("  continue: OK");
  } catch (error) {
    log("  continue: THREW", error instanceof Error ? error.message : String(error));
  }
  inspect("final", sm, agent);
}

async function runScenarioB(): Promise<void> {
  LOG.push("===== 场景 B：run 结束后宿主落盘 + rebuild + continue =====");
  const dir = mkdtempSync(join(tmpdir(), "piweb-verify-b-"));
  const sm = SessionManager.create(dir);
  const calls: LlmCall[] = [];
  const agent = makeAgent(calls, sm);

  const p0 = agent.prompt([{ role: "user", content: [{ type: "text", text: "U0" }], timestamp: Date.now() }] as never);
  while (calls.length < 1) await new Promise((r) => setTimeout(r, 5));
  await calls[0]!.release();
  await p0;

  // run 结束后宿主落盘 U1（模拟用户消息在 run 结束瞬间物化）
  const u1Id = sm.appendMessage({ role: "user", content: [{ type: "text", text: "U1" }], timestamp: Date.now() } as never);
  log("  host appended U1 ->", u1Id.slice(0, 4));
  agent.state.messages = sm.buildSessionContext().messages;
  log("  [after rebuild] last role", agent.state.messages.at(-1)?.role);
  log("  [after rebuild] state contains U1?", agent.state.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("U1")));

  // continue 触发下一轮
  const p1 = agent.continue();
  while (calls.length < 2) await new Promise((r) => setTimeout(r, 5));
  log("  [continue-run] LLM sees users:", calls[1]!.userTexts);
  calls[1]!.release();
  await p1;
  inspect("final", sm, agent);
}

await runScenarioA();
await runScenarioB();
console.log(LOG.join("\n"));
