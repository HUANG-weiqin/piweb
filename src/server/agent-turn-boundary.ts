import type {
  AgentSession,
  ContextUsage,
} from "@earendil-works/pi-coding-agent";
import { measureSerializedContextBytes } from "./provider-context-pressure.js";

export interface AgentTurnBoundaryCheck {
  contextUsage: ContextUsage | undefined;
  hasToolResults: boolean;
  serializedContextBytes?: number;
}

export type AgentTurnBoundaryHandler = (
  input: AgentTurnBoundaryCheck,
) => boolean;

interface TurnBoundaryContext {
  context: unknown;
  toolResults: unknown[];
}

interface AgentLoopConfig {
  shouldStopAfterTurn?: (
    context: TurnBoundaryContext,
  ) => boolean | Promise<boolean>;
}

interface AgentLoopOwner {
  createLoopConfig(...args: unknown[]): AgentLoopConfig;
  hasQueuedMessages(): boolean;
}

export interface AgentTurnBoundaryController {
  releaseQueuePause(): void;
  dispose(): void;
}

/**
 * Bridges Pi core's graceful post-turn stop hook, which AgentSession does not
 * currently expose. Keep this SDK-shape dependency isolated here.
 */
export function installAgentTurnBoundaryCheck(
  session: AgentSession,
  handler: AgentTurnBoundaryHandler,
): AgentTurnBoundaryController {
  const agent = session.agent as unknown as AgentLoopOwner;
  const original = agent.createLoopConfig;
  const originalHasQueuedMessages = agent.hasQueuedMessages;
  if (
    typeof original !== "function"
    || typeof originalHasQueuedMessages !== "function"
  ) {
    throw new Error("Pi Agent does not expose its turn-boundary queue controls");
  }

  const hadOwnMethod = Object.hasOwn(agent, "createLoopConfig");
  const hadOwnQueueCheck = Object.hasOwn(agent, "hasQueuedMessages");
  let queuePaused = false;
  function createLoopConfig(
    this: AgentLoopOwner,
    ...args: unknown[]
  ): AgentLoopConfig {
    const config = original.apply(this, args);
    const previousShouldStop = config.shouldStopAfterTurn;
    return {
      ...config,
      shouldStopAfterTurn: async (context) => {
        let hostShouldStop = false;
        try {
          hostShouldStop = handler({
            contextUsage: session.getContextUsage(),
            hasToolResults: context.toolResults.length > 0,
            serializedContextBytes: measureSerializedContextBytes(
              context.context,
            ),
          });
        } catch {
          // Pi requires this callback to be non-throwing. A later boundary can
          // retry the advisory host check without breaking the Agent loop.
        }
        if (hostShouldStop) queuePaused = true;
        return Boolean(await previousShouldStop?.call(config, context))
          || hostShouldStop;
      },
    };
  }

  function hasQueuedMessages(this: AgentLoopOwner): boolean {
    return !queuePaused && originalHasQueuedMessages.call(this);
  }

  agent.createLoopConfig = createLoopConfig;
  agent.hasQueuedMessages = hasQueuedMessages;
  let installed = true;
  return {
    releaseQueuePause: () => {
      queuePaused = false;
    },
    dispose: () => {
      if (!installed) return;
      installed = false;
      queuePaused = false;
      if (agent.createLoopConfig === createLoopConfig) {
        if (hadOwnMethod) agent.createLoopConfig = original;
        else delete (agent as Partial<AgentLoopOwner>).createLoopConfig;
      }
      if (agent.hasQueuedMessages === hasQueuedMessages) {
        if (hadOwnQueueCheck) agent.hasQueuedMessages = originalHasQueuedMessages;
        else delete (agent as Partial<AgentLoopOwner>).hasQueuedMessages;
      }
    },
  };
}
