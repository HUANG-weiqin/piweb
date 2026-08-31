import type { AgentSession } from "@earendil-works/pi-coding-agent";

type ConvertToLlm = AgentSession["agent"]["convertToLlm"];
type AgentMessage = Parameters<ConvertToLlm>[0][number];
type LlmMessages = Awaited<ReturnType<ConvertToLlm>>;

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
): string | undefined {
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
  if (usage.tokens === null) {
    return `<piweb_ctx used="unknown/${formatTokens(window)}" auto_compact="${thresholdPercent}%" />`;
  }
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
  return `<piweb_ctx used="${formatTokens(usage.tokens)}/${formatTokens(window)}" auto_compact="${thresholdPercent}%" remaining="${formatTokens(remaining)}"${warning} />`;
}

function appendTelemetry(
  messages: LlmMessages,
  telemetry: string,
): LlmMessages {
  const lastMessage = messages.at(-1);
  if (
    !lastMessage
    || (lastMessage.role !== "user" && lastMessage.role !== "toolResult")
  ) {
    return messages;
  }

  const telemetryPart = { type: "text" as const, text: telemetry };
  const content = typeof lastMessage.content === "string"
    ? [{ type: "text" as const, text: lastMessage.content }, telemetryPart]
    : [...lastMessage.content, telemetryPart];
  return [
    ...messages.slice(0, -1),
    { ...lastMessage, content },
  ];
}

export function installAgentContextBudget(
  session: AgentSession,
  getCompactionThresholdPercent: () => number,
): AgentContextBudgetController {
  const agent = session.agent;
  const original = agent.convertToLlm;
  if (typeof original !== "function") {
    throw new Error("Pi Agent does not expose convertToLlm");
  }

  const hadOwnConverter = Object.hasOwn(agent, "convertToLlm");
  async function convertToLlm(
    this: AgentSession["agent"],
    messages: AgentMessage[],
  ): Promise<LlmMessages> {
    const converted = await original.call(this, messages);
    try {
      const usage = session.getContextUsage();
      const thresholdPercent = getCompactionThresholdPercent();
      const telemetry = createTelemetry(usage, thresholdPercent);
      return telemetry ? appendTelemetry(converted, telemetry) : converted;
    } catch {
      return converted;
    }
  }

  agent.convertToLlm = convertToLlm;
  let installed = true;
  return {
    dispose(): void {
      if (!installed) return;
      installed = false;
      if (agent.convertToLlm !== convertToLlm) return;
      if (hadOwnConverter) agent.convertToLlm = original;
      else delete (agent as Partial<AgentSession["agent"]>).convertToLlm;
    },
  };
}
