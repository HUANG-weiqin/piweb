import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentTurnBoundaryCheck,
  installAgentTurnBoundaryCheck,
} from "./agent-turn-boundary.js";

describe("installAgentTurnBoundaryCheck", () => {
  it("reports token usage without serializing the raw Agent context", async () => {
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
    const toJSON = vi.fn(() => {
      throw new Error("raw context must not drive compaction");
    });
    const controller = installAgentTurnBoundaryCheck(session, (input) => {
      observed = input;
      return false;
    });

    const config = agent.createLoopConfig() as {
      shouldStopAfterTurn(input: unknown): Promise<boolean>;
    };
    await config.shouldStopAfterTurn({
      context: { toJSON },
      toolResults: [{}],
    });

    expect(observed).toEqual({
      contextUsage: {
        tokens: 45,
        contextWindow: 100,
        percent: 45,
      },
      hasToolResults: true,
    });
    expect(toJSON).not.toHaveBeenCalled();
    controller.dispose();
  });
});
