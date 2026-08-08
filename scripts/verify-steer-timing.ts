/**
 * SDK steer 时序验证（用户消息改走 steering 队列后的行为确认）：
 * 1. busy 时 prompt(steer) 的 promise 立即 resolve（preflightResult(true)）
 * 2. steer 消息在当前 assistant turn 工具调用全部结束后、下一次模型调用前注入
 *    ——而不是像 followUp 那样等整个 run 自然结束
 * 3. 注入后 run 继续（模型处理该消息，可再发起工具调用）
 * 4. abort 清空 steer 队列
 * 5. run 结束时残留在 steer 队列的消息：下一次 run 开始时注入
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

function makeAgent(
  calls: LlmCall[],
  events: EventRecord[],
  steeringMode: "all" | "one-at-a-time" = "one-at-a-time",
) {
  const agent = new Agent({
    initialState: {
      systemPrompt: "",
      model: { id: "fake", provider: "fake", description: "fake", label: "fake", options: {} } as never,
      thinkingLevel: "off",
      tools: [],
    },
    streamFn: makeFakeStreamFn(calls, (n) => {
      console.log(`  [llm#${n}] called`);
      if (n > 0) setTimeout(() => calls[n]!.release(), 10);
    }),
    convertToLlm: (messages: unknown[]) => messages as never,
    steeringMode,
    followUpMode: "one-at-a-time",
  });
  agent.subscribe(async (event: { type: string; message?: { role: string; content?: Array<{ text?: string }> } }) => {
    const text = Array.isArray(event.message?.content)
      ? event.message.content.map((c) => c.text ?? "?").join("")
      : undefined;
    events.push({ type: event.type, role: event.message?.role, text });
  });
  return agent;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function main() {
  console.log("=== 场景 1：busy run 中 prompt(steer)，消息在工具序列结束后、下一次模型调用前注入 ===");
  {
    const calls: LlmCall[] = [];
    const events: EventRecord[] = [];
    const agent = makeAgent(calls, events);
    const run = agent.prompt([{ role: "user", content: [{ type: "text", text: "initial task" }], timestamp: Date.now() }] as never);
    await waitFor(() => calls.length === 1, "llm#0");
    console.log("  [t0] run 进行中（llm#0 已调用，等待释放）");

    // 模拟 AgentSession.prompt(text, {streamingBehavior:"steer", preflightResult})：
    // _queueSteer 同步入队后立即 preflightResult(true)，promise 马上 resolve。
    agent.steer({ role: "user", content: [{ type: "text", text: "方向错了，改成 X" }], timestamp: Date.now() });
    console.log("  [t1] prompt(steer) 已入队，preflightResult(true) —— 宿主可回 prompt_admitted");

    calls[0]!.release(); // 释放 llm#0：assistant 响应完成、无工具调用 → 内层循环回来取 steering
    await waitFor(() => {
      const injected = events.some((e) => e.type === "message_end" && e.role === "user" && e.text === "方向错了，改成 X");
      return injected;
    }, "steer 消息注入");
    console.log("  [t2] steer 消息在 llm#0 完成后立即注入（message_end user）");
    await waitFor(() => calls.length >= 2, "llm#1 被调用");
    console.log("  [t3] 注入后立即发起下一次模型调用（llm#1 携带该消息）");
    await run;
    console.log("  [t4] run 完成");
  }

  console.log("\n=== 场景 2：steer 消息注入后 run 是否被'续命'（模型可继续工具循环）===");
  {
    const calls: LlmCall[] = [];
    const events: EventRecord[] = [];
    const agent = makeAgent(calls, events);
    const run = agent.prompt([{ role: "user", content: [{ type: "text", text: "first task" }], timestamp: Date.now() }] as never);
    await waitFor(() => calls.length === 1, "llm#0");
    agent.steer({ role: "user", content: [{ type: "text", text: "继续干" }], timestamp: Date.now() });
    calls[0]!.release();
    await waitFor(() => calls.length >= 2, "llm#1（steer 后）");
    console.log(`  [t1] steer 注入后模型被调用：llm#1 上下文 user 消息 = ${JSON.stringify(calls[1]!.userTexts)}`);
    calls[1]!.release();
    await run;
    console.log("  [t2] 无更多 steering/followUp 时 run 正常结束");
  }

  console.log("\n=== 场景 3：abort 清空 steer 队列（未注入消息丢失）===");
  {
    const calls: LlmCall[] = [];
    const events: EventRecord[] = [];
    const agent = makeAgent(calls, events);
    const run = agent.prompt([{ role: "user", content: [{ type: "text", text: "long task" }], timestamp: Date.now() }] as never);
    await waitFor(() => calls.length === 1, "llm#0");
    agent.steer({ role: "user", content: [{ type: "text", text: "会被 abort 清掉" }], timestamp: Date.now() });
    // AgentSession.abort → clearQueue() → agent.steeringQueue.clear()
    agent.steeringQueue.clear();
    console.log("  [t1] steering 队列已清空（等待中消息消失）");
    calls[0]!.release();
    await run;
    const injected = events.some((e) => e.type === "message_end" && e.role === "user" && e.text === "会被 abort 清掉");
    console.log(`  [t2] abort 清空后消息未注入: ${!injected}（符合预期）`);
  }

  console.log("\n=== 场景 4：run 结束后才入队的 steer 消息，下一次 run 开始时注入 ===");
  {
    const calls: LlmCall[] = [];
    const events: EventRecord[] = [];
    const agent = makeAgent(calls, events);
    const run = agent.prompt([{ role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() }] as never);
    await waitFor(() => calls.length === 1, "llm#0");
    calls[0]!.release();
    await run;
    console.log("  [t1] run#1 已结束");
    agent.steer({ role: "user", content: [{ type: "text", text: "迟到消息" }], timestamp: Date.now() });
    const run2 = agent.prompt([{ role: "user", content: [{ type: "text", text: "second" }], timestamp: Date.now() }] as never);
    await waitFor(() => calls.length >= 2, "llm#1（run#2）");
    const hasLate = calls[1]!.userTexts.includes("迟到消息");
    console.log(`  [t2] run#2 首次模型调用携带迟到消息: ${hasLate}`);
    calls[1]!.release();
    await run2;
  }

  console.log("\n=== 场景 5：steer 与 followUp 并存时 steer 先注入 ===");
  {
    const calls: LlmCall[] = [];
    const events: EventRecord[] = [];
    const agent = makeAgent(calls, events);
    const run = agent.prompt([{ role: "user", content: [{ type: "text", text: "busy" }], timestamp: Date.now() }] as never);
    await waitFor(() => calls.length === 1, "llm#0");
    agent.followUp({ role: "user", content: [{ type: "text", text: "followUp 消息" }], timestamp: Date.now() });
    agent.steer({ role: "user", content: [{ type: "text", text: "steer 消息" }], timestamp: Date.now() });
    calls[0]!.release();
    await waitFor(() => calls.length >= 2, "llm#1");
    console.log(`  [t1] 工具序列结束后第一个模型调用携带: ${JSON.stringify(calls[1]!.userTexts.filter((t) => t.includes("消息")))}`);
    console.log(`  [t2] steer 已注入（followUp 要等 run 结束才读）: ${calls[1]!.userTexts.includes("steer 消息")} / followUp 未注入: ${!calls[1]!.userTexts.includes("followUp 消息")}`);
    calls[1]!.release();
    await waitFor(() => calls.length >= 3, "llm#2（followUp 触发）");
    console.log(`  [t3] run 结束后 followUp 才被读取: ${calls[2]!.userTexts.includes("followUp 消息")}`);
    calls[2]!.release();
    await run;
  }

  console.log("\n=== 场景 6：steeringMode=all 时多条用户消息一次全部注入 ===");
  {
    const calls: LlmCall[] = [];
    const events: EventRecord[] = [];
    const agent = makeAgent(calls, events, "all");
    const run = agent.prompt([{ role: "user", content: [{ type: "text", text: "busy" }], timestamp: Date.now() }] as never);
    await waitFor(() => calls.length === 1, "llm#0");
    // busy 期间用户连发 3 条
    agent.steer({ role: "user", content: [{ type: "text", text: "M1" }], timestamp: Date.now() });
    agent.steer({ role: "user", content: [{ type: "text", text: "M2" }], timestamp: Date.now() });
    agent.steer({ role: "user", content: [{ type: "text", text: "M3" }], timestamp: Date.now() });
    console.log("  [t1] busy 中连发 M1/M2/M3（均入 steering 队列）");
    calls[0]!.release();
    await waitFor(() => calls.length >= 2, "llm#1");
    const injected = calls[1]!.userTexts.filter((t) => t.startsWith("M"));
    console.log(`  [t2] llm#1 一次看到全部: ${JSON.stringify(injected)}（all=${injected.length === 3}）`);
    calls[1]!.release();
    await run;
    const userEnds = events.filter((e) => e.type === "message_end" && e.role === "user" && e.text?.startsWith("M"));
    console.log(`  [t3] 注入事件连续发生: ${userEnds.map((e) => e.text).join(",")}`);
  }

  console.log("\n全部场景验证完成 ✓");
}

main().catch((error) => {
  console.error("验证失败:", error);
  process.exit(1);
});
