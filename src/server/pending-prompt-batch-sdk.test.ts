import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js";
import { createPendingPromptBatchGuidance } from "./conversation-actor.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assistantMessage(model: Model<string>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  };
}

describe("pending prompt batch against the locked Pi agent loop", () => {
  it("places every member in one SDK user message for one next logical model turn", async () => {
    const model: Model<string> = {
      id: "batch-contract-test",
      name: "Batch contract test",
      api: "batch-contract-test",
      provider: "batch-contract-test",
      baseUrl: "http://127.0.0.1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_000,
    };
    const firstTurn = deferred();
    const contexts: Context[] = [];
    const agent = new Agent({
      initialState: { model, systemPrompt: "test", tools: [] },
      streamFn: (activeModel, context) => {
        const turn = contexts.push(structuredClone(context));
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (turn === 1) await firstTurn.promise;
          const message = assistantMessage(activeModel, `answer ${turn}`);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        })();
        return stream;
      },
    });
    expect(agent.steeringMode).toBe("one-at-a-time");

    const run = agent.prompt("initial request");
    while (contexts.length === 0) await Promise.resolve();
    const guidance = createPendingPromptBatchGuidance(
      "9e3bc4fb-9ec5-4aa4-9b35-b76100d18a74",
      ["first pending", "second pending", "third pending"],
    );
    agent.steer({
      role: "user",
      content: [{ type: "text", text: guidance }],
      timestamp: Date.now(),
    });
    firstTurn.resolve();
    await run;

    expect(contexts).toHaveLength(2);
    const nextTurnUsers = contexts[1]!.messages.filter(({ role }) => role === "user");
    expect(nextTurnUsers).toHaveLength(2);
    expect(nextTurnUsers[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: guidance }],
    });
    expect(JSON.parse(guidance)).toMatchObject({
      items: [
        { ordinal: 1, text: "first pending" },
        { ordinal: 2, text: "second pending" },
        { ordinal: 3, text: "third pending" },
      ],
    });
  });
});
