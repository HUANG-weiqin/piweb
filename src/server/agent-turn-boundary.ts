import type {
  AgentSession,
  ContextUsage,
} from "@earendil-works/pi-coding-agent";

export interface AgentTurnBoundaryCheck {
  contextUsage: ContextUsage | undefined;
}

export type AgentTurnBoundaryHandler = (
  input: AgentTurnBoundaryCheck,
) => boolean;

type FinishTurn = NonNullable<AgentSession["agent"]["finishTurn"]>;

export interface AgentTurnBoundaryController {
  /** Durable frontier before the last conversational provider request. */
  observedLeafId(): string | null | undefined;
  releaseQueuePause(): void;
  dispose(): void;
}

/**
 * Bridges Pi core's completed-tool-turn hook while preserving its own decision
 * and the SDK's queued steering messages across the host compaction checkpoint.
 */
export function installAgentTurnBoundaryCheck(
  session: AgentSession,
  handler: AgentTurnBoundaryHandler,
): AgentTurnBoundaryController {
  const agent = session.agent;
  const previousFinishTurn = agent.finishTurn;
  const previousHasQueuedMessages = agent.hasQueuedMessages;
  const previousPrepareRequest = agent.prepareRequest;
  const hadOwnPrepareRequest = Object.hasOwn(agent, "prepareRequest");
  let observedLeaf: string | null | undefined;
  const prepareRequest: NonNullable<typeof agent.prepareRequest> = async (request, signal) => {
    observedLeaf = undefined;
    const update = await previousPrepareRequest?.call(agent, request, signal);
    if (!signal?.aborted) observedLeaf = session.sessionManager.getLeafId();
    return update ?? undefined;
  };
  if (typeof previousHasQueuedMessages !== "function") {
    throw new Error("Pi Agent does not expose its turn-boundary queue controls");
  }

  const hadOwnFinishTurn = Object.hasOwn(agent, "finishTurn");
  const hadOwnQueueCheck = Object.hasOwn(agent, "hasQueuedMessages");
  let queuePaused = false;

  const finishTurn: FinishTurn = async (turn, signal) => {
    const previousDecision = await previousFinishTurn?.call(agent, turn, signal);
    if (previousDecision !== undefined) return previousDecision;

    if (
      turn.message.stopReason !== "toolUse"
      || turn.toolResults.length === 0
    ) {
      return;
    }

    let hostShouldStop = false;
    try {
      hostShouldStop = handler({
        contextUsage: session.getContextUsage(),
      });
    } catch {
      // Pi requires host boundary checks to be non-throwing. A later boundary
      // can retry the advisory check without breaking the Agent loop.
    }

    if (!hostShouldStop) return;

    queuePaused = true;
    return { action: "end" };
  };

  const hasQueuedMessages: AgentSession["agent"]["hasQueuedMessages"] = function () {
    return !queuePaused && previousHasQueuedMessages.call(agent);
  };

  agent.prepareRequest = prepareRequest;
  agent.finishTurn = finishTurn;
  agent.hasQueuedMessages = hasQueuedMessages;

  let installed = true;
  return {
    observedLeafId: () => observedLeaf,
    releaseQueuePause: () => {
      queuePaused = false;
    },
    dispose: () => {
      if (!installed) return;
      installed = false;
      queuePaused = false;
      observedLeaf = undefined;
      if (agent.prepareRequest === prepareRequest) {
        if (hadOwnPrepareRequest) agent.prepareRequest = previousPrepareRequest;
        else delete (agent as Partial<typeof agent>).prepareRequest;
      }
      if (agent.finishTurn === finishTurn) {
        if (hadOwnFinishTurn) agent.finishTurn = previousFinishTurn;
        else delete (agent as Partial<typeof agent>).finishTurn;
      }
      if (agent.hasQueuedMessages === hasQueuedMessages) {
        if (hadOwnQueueCheck) agent.hasQueuedMessages = previousHasQueuedMessages;
        else delete (agent as Partial<typeof agent>).hasQueuedMessages;
      }
    },
  };
}
