import type { AgentSession } from "@earendil-works/pi-coding-agent";

type TransformContext = NonNullable<AgentSession["agent"]["transformContext"]>;
type AgentMessage = Parameters<TransformContext>[0][number];

export const AGENT_CONTEXT_BUDGET_CUSTOM_TYPE = "piweb.context_budget.v1";

export interface AgentContextBudgetController {
  dispose(): void;
}

function formatTokens(tokens: number): string {
  const absoluteTokens = Math.abs(tokens);
  let divisor = 1;
  let suffix = "";
  if (absoluteTokens >= 1_000_000) {
    divisor = 1_000_000;
    suffix = "M";
  } else if (absoluteTokens >= 1_000) {
    divisor = 1_000;
    suffix = "k";
  }
  const rounded = Math.round((tokens / divisor) * 10) / 10;
  return `${rounded}${suffix}`;
}

function createTelemetry(
  usage: ReturnType<AgentSession["getContextUsage"]>,
  thresholdPercent: number,
): AgentMessage | undefined {
  if (
    !usage
    || !Number.isFinite(usage.contextWindow)
    || usage.contextWindow <= 0
    || !Number.isFinite(thresholdPercent)
    || thresholdPercent <= 0
    || thresholdPercent > 100
  ) {
    return undefined;
  }

  const window = usage.contextWindow;
  let content: string;
  if (usage.tokens === null) {
    content = `<piweb_ctx used="unknown/${formatTokens(window)}" auto_compact="${thresholdPercent}%" />`;
  } else {
    if (!Number.isFinite(usage.tokens) || usage.tokens < 0) return undefined;
    const remaining = Math.max(
      0,
      (window * thresholdPercent) / 100 - usage.tokens,
    );
    const warning = typeof usage.percent === "number"
      && Number.isFinite(usage.percent)
      && usage.percent >= thresholdPercent - 5
      ? " warning=\"Compaction soon; consider updating Agent Notebook.\""
      : "";
    content = `<piweb_ctx used="${formatTokens(usage.tokens)}/${formatTokens(window)}" auto_compact="${thresholdPercent}%" remaining="${formatTokens(remaining)}"${warning} />`;
  }

  return {
    role: "custom",
    customType: AGENT_CONTEXT_BUDGET_CUSTOM_TYPE,
    content,
    display: false,
    timestamp: Date.now(),
  };
}

export function installAgentContextBudget(
  session: AgentSession,
  getCompactionThresholdPercent: () => number,
): AgentContextBudgetController {
  const agent = session.agent;
  const candidate = agent.transformContext;
  if (typeof candidate !== "function") {
    throw new Error("Pi Agent does not expose transformContext");
  }
  const original: TransformContext = candidate;

  const hadOwnTransform = Object.hasOwn(agent, "transformContext");
  async function transformContext(
    this: AgentSession["agent"],
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const transformed = await original.call(this, messages, signal);
    try {
      const usage = session.getContextUsage();
      const thresholdPercent = getCompactionThresholdPercent();
      const telemetry = createTelemetry(usage, thresholdPercent);
      if (!telemetry) return transformed;
      return [
        ...transformed.filter((message) => (
          message.role !== "custom"
          || message.customType !== AGENT_CONTEXT_BUDGET_CUSTOM_TYPE
        )),
        telemetry,
      ];
    } catch {
      return transformed;
    }
  }

  agent.transformContext = transformContext;
  let installed = true;
  return {
    dispose(): void {
      if (!installed) return;
      installed = false;
      if (agent.transformContext !== transformContext) return;
      if (hadOwnTransform) agent.transformContext = original;
      else delete agent.transformContext;
    },
  };
}
