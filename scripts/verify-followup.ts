/**
 * SDK followUp 行为验证（方案 A' 地基）：
 * 1. followUpMode=all vs one-at-a-time 的 drain 差异（投递顺序、assistant 次数）
 * 2. 排队消息投递的事件序列（message_start/end 与 assistant 的先后）
 * 3. abort 时队列行为（清空/保留、run 结束后是否继续）
 * 4. run 结束时队列 drain 的精确时机（外层循环 vs _handlePostAgentRun.continue）
 */
import { Agent } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js";
import { AssistantMessageEventStream } from "../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";

interface LlmCall {
  userTexts: string[];
  release: () => void;
}

function makeFakeStreamFn(calls: LlmCall[], onCall?: (n: number) => void) {
  return async (_model: unknown, context: { messages: Array<{ role: string; content: unknown }> }) => {
    const userTexts = context.messages
      .filter((m) => m.role === "user")
      .map((m) => Array.isArray(m.content)
        ? m.content.map((c: { text?: string }) => c.text ?? "?").join("")
        : String(m.content));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const callIndex = calls.length;
    calls.push({ userTexts, release });
    onCall?.(callIndex);
    await gate;
    const stream = new AssistantMessageEventStream();
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: `A${callIndex}:[${userTexts.join("|")}]` }],
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

interface EventRecord { type: string; role?: string; text?: string }

function makeAgent(mode: "all" | "one-at-a-time", calls: LlmCall[], events: EventRecord[]) {
  const agent = new Agent({
    initialState: {
      systemPrompt: "",
      model: { id: "fake", provider: "fake", description: "fake", label: "fake", options: {} } as never,
      thinkingLevel: "off",
      tools: [],
    },
    streamFn: makeFakeStreamFn(calls, (n) => {
      console.log(`  [llm#${n}] called`);
      // 后续 LLM 调用（followUp drain）自动释放，只有首个 run 由脚本控制
      if (n > 0) setTimeout(() => calls[n]!.release(), 10);
    }),
    convertToLlm: (messages: unknown[]) => messages as never,
    followUpMode: mode,
  });
  agent.subscribe(async (event: { type: string; message?: { role: string; content?: Array<{ text?: string }> } }) => {
    const text = Array.isArray(event.message?.content)
      ? event.message.content.map((c) => c.text ?? "?").join("")
      : undefined;
    events.push({ type: event.type, role: event.message?.role, text });
    if (event.type === "message_end" && event.message) {
      // 模拟 AgentSession 持久化（记录即可，这里不落盘）
      console.log(`  [event] ${event.type} ${event.message.role} ${text ?? ""}`);
    }
  });
  return agent;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function scenario(mode: "all" | "one-at-a-time", withAbort: boolean): Promise<void> {
  console.log(`\n===== mode=${mode} abort=${withAbort} =====`);
  const calls: LlmCall[] = [];
  const events: EventRecord[] = [];
  const agent = makeAgent(mode, calls, events);

  // run 1：U0
  const p0 = agent.prompt([{ role: "user", content: [{ type: "text", text: "U0" }], timestamp: Date.now() }] as never);
  await waitFor(() => calls.length >= 1, "llm#0");
  // busy 期间用户连发两条
  agent.followUp({ role: "user", content: [{ type: "text", text: "U1" }], timestamp: Date.now() });
  agent.followUp({ role: "user", content: [{ type: "text", text: "U2" }], timestamp: Date.now() });
  console.log("  [busy] queued U1, U2");
  if (withAbort) {
    agent.abort();
    console.log("  [busy] aborted");
  }
  calls[0]!.release();
  await p0;
  console.log("  [run1 done] queued:", agent.hasQueuedMessages());
  console.log("  [result] p0 resolved（promise 覆盖全部队列 drain）");
  const userMsgs = events.filter((e) => e.type === "message_end" && e.role === "user").map((e) => e.text);
  const assistantMsgs = events.filter((e) => e.type === "message_end" && e.role === "assistant").map((e) => e.text);
  console.log("  [events] user ends:", JSON.stringify(userMsgs));
  console.log("  [events] assistant ends:", JSON.stringify(assistantMsgs));
  console.log("  [events] agent_end 次数:", events.filter((e) => e.type === "agent_end").length);
}

await scenario("all", false);
await scenario("one-at-a-time", false);
await scenario("all", true);
