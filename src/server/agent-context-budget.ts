import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LoopList } from "../shared/protocol.js";
import { CONTEXT_HINT_CUSTOM_TYPE } from "./conversation-meta.js";

type ConvertToLlm = AgentSession["agent"]["convertToLlm"];
type AgentMessage = Parameters<ConvertToLlm>[0][number];
type LlmMessages = Awaited<ReturnType<ConvertToLlm>>;

const PIWEB_WORK_RECORD_MAX_BYTES = 4096;

/** At most one hint per minute; the fields it carries are minute-granular. */
export const CONTEXT_HINT_MIN_INTERVAL_MS = 60_000;

export interface AgentContextBudgetController {
  dispose(): void;
}

export interface LoopListElapsedMinutes {
  activeMin: number;
  listMin: number;
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

function createWorkHint(
  active: Array<{ id: string; text: string }>,
  elapsed?: LoopListElapsedMinutes,
): string {
  const elapsedFields = elapsed === undefined
    ? {}
    : {
        activeElapsedMinutes: elapsed.activeMin,
        loopListElapsedMinutes: elapsed.listMin,
      };
  for (let included = active.length; included > 0; included -= 1) {
    const omitted = active.length - included;
    const record = `piweb_work=${JSON.stringify({
      active: active.slice(0, included),
      ...(omitted > 0 ? { omitted } : {}),
      ...elapsedFields,
    })}`;
    if (Buffer.byteLength(record, "utf8") <= PIWEB_WORK_RECORD_MAX_BYTES) {
      return record;
    }
  }

  return `piweb_work=${JSON.stringify({
    active: [],
    omitted: active.length,
    ...elapsedFields,
  })}`;
}

export function installAgentContextBudget(
  session: AgentSession,
  getLoopList: () => LoopList,
  getCompactionThresholdPercent?: () => number,
  getLoopListElapsedMinutes?: () => LoopListElapsedMinutes | undefined,
): AgentContextBudgetController {
  const agent = session.agent;
  const original = agent.convertToLlm;
  if (typeof original !== "function") {
    throw new Error("Pi Agent does not expose convertToLlm");
  }

  const hadOwnConverter = Object.hasOwn(agent, "convertToLlm");
  let lastHintAt: number | undefined;

  async function convertToLlm(
    this: AgentSession["agent"],
    messages: AgentMessage[],
  ): Promise<LlmMessages> {
    const converted = await original.call(this, messages);

    let active: Array<{ id: string; text: string }>;
    try {
      active = getLoopList().items
        .filter((item) => item.status === "active")
        .map(({ id, text }) => ({ id, text }));
      if (active.length === 0) return converted;
    } catch {
      // Active work is the admission boundary for the LoopList hint only.
      return converted;
    }

    let elapsedMinutes: LoopListElapsedMinutes | undefined;
    if (getLoopListElapsedMinutes) {
      try {
        elapsedMinutes = getLoopListElapsedMinutes();
      } catch {
        // The active-work reminder remains useful without this optional fact.
      }
    }
    const workHint = createWorkHint(active, elapsedMinutes);

    let telemetry: string | undefined;
    if (getCompactionThresholdPercent) {
      try {
        telemetry = createTelemetry(
          session.getContextUsage(),
          getCompactionThresholdPercent(),
        );
      } catch {
        // Provider context hints are transient and must not block a model call.
      }
    }

    const now = Date.now();
    if (
      lastHintAt !== undefined
      && now - lastHintAt < CONTEXT_HINT_MIN_INTERVAL_MS
    ) {
      return converted;
    }

    const providerTail = telemetry ? `${telemetry}\n${workHint}` : workHint;
    try {
      // Durable hint: a streaming session queues it as steering for the next
      // model call, an idle session appends it for the next run. Either way it
      // stays in history, so later requests remain strict extensions.
      await session.sendCustomMessage(
        {
          customType: CONTEXT_HINT_CUSTOM_TYPE,
          content: providerTail,
          display: false,
        },
        session.isStreaming ? { triggerTurn: true } : { triggerTurn: false },
      );
      lastHintAt = now;
    } catch {
      // The hint is best-effort and must not block a model call.
    }
    return converted;
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
