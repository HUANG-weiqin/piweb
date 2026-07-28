import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  type AgentTurnBoundaryCheck,
  installAgentTurnBoundaryCheck,
} from "./agent-turn-boundary.js";
import { measureSerializedContextBytes } from "./provider-context-pressure.js";

describe("installAgentTurnBoundaryCheck", () => {
  it("returns undefined rather than throwing for an unserializable context", () => {
    const context: { self?: unknown } = {};
    context.self = context;

    expect(measureSerializedContextBytes(context)).toBeUndefined();
  });

  it("reports the UTF-8 size of the exact post-tool agent context", async () => {
    let observed: AgentTurnBoundaryCheck | undefined;
    const agent = {
      createLoopConfig: () => ({}),
      hasQueuedMessages: () => true,
    };
    const session = {
      agent,
      getContextUsage: () => ({
        tokens: 45,
        contextWindow: 100,
        percent: 45,
      }),
    } as unknown as AgentSession;
    const context = {
      systemPrompt: "系统",
      messages: [{ role: "toolResult", content: "x".repeat(32) }],
      tools: [{ name: "read", description: "读取" }],
    };
    const controller = installAgentTurnBoundaryCheck(session, (input) => {
      observed = input;
      return false;
    });

    const config = agent.createLoopConfig() as {
      shouldStopAfterTurn(input: unknown): Promise<boolean>;
    };
    await config.shouldStopAfterTurn({ context, toolResults: [{}] });

    expect(observed?.serializedContextBytes).toBe(
      Buffer.byteLength(JSON.stringify(context), "utf8"),
    );
    controller.dispose();
  });
});
