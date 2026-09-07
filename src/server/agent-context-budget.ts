import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { LoopList } from "../shared/protocol.js";

type ConvertToLlm = AgentSession["agent"]["convertToLlm"];
type AgentMessage = Parameters<ConvertToLlm>[0][number];
type LlmMessages = Awaited<ReturnType<ConvertToLlm>>;

const PIWEB_WORK_RECORD_MAX_BYTES = 4096;

export interface AgentContextBudgetController {
  dispose(): void;
}

export interface LoopListElapsedMinutes {
  activeMin: number;
  listMin: number;
}

/**
 * A run-scoped image which is copied only into the provider request. It never
 * becomes an AgentMessage or a persisted tool result.
 */
export interface ComputerProviderImage {
  readonly sourceToolCallId: string;
  readonly image: ImageContent;
}

export interface ComputerProviderImageResolver {
  get(): ComputerProviderImage | undefined;
  presented(sourceToolCallId: string): void;
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
  editLeft?: number,
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
      ...(editLeft === undefined ? {} : { editLeft }),
    })}`;
    if (Buffer.byteLength(record, "utf8") <= PIWEB_WORK_RECORD_MAX_BYTES) {
      return record;
    }
  }

  return `piweb_work=${JSON.stringify({
    active: [],
    omitted: active.length,
    ...elapsedFields,
    ...(editLeft === undefined ? {} : { editLeft }),
  })}`;
}

function appendProviderImage(
  messages: LlmMessages,
  candidate: ComputerProviderImage | undefined,
): { messages: LlmMessages; presented?: string } {
  if (!candidate) return { messages };
  let index = -1;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor]!;
    if (
      message.role === "toolResult"
      && message.toolCallId === candidate.sourceToolCallId
    ) {
      index = cursor;
      break;
    }
  }
  if (index < 0) return { messages };
  const target = messages[index]!;
  if (target.role !== "toolResult") return { messages };
  const content = typeof target.content === "string"
    ? [{ type: "text" as const, text: target.content }, candidate.image]
    : [...target.content, candidate.image];
  return {
    messages: [
      ...messages.slice(0, index),
      { ...target, content },
      ...messages.slice(index + 1),
    ],
    presented: candidate.sourceToolCallId,
  };
}

function appendProviderTail(
  messages: LlmMessages,
  providerTail: string,
): LlmMessages {
  const lastMessage = messages.at(-1);
  if (
    !lastMessage
    || (lastMessage.role !== "user" && lastMessage.role !== "toolResult")
  ) {
    return messages;
  }

  const tailPart = { type: "text" as const, text: providerTail };
  const content = typeof lastMessage.content === "string"
    ? [{ type: "text" as const, text: lastMessage.content }, tailPart]
    : [...lastMessage.content, tailPart];
  return [
    ...messages.slice(0, -1),
    { ...lastMessage, content },
  ];
}

export function installAgentContextBudget(
  session: AgentSession,
  getLoopList: () => LoopList,
  getCompactionThresholdPercent?: () => number,
  getEditBudgetRemainingFiles?: () => number | undefined,
  getLoopListElapsedMinutes?: () => LoopListElapsedMinutes | undefined,
  computerProviderImage?: ComputerProviderImageResolver,
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
    let providerMessages = converted;
    let candidate: ComputerProviderImage | undefined;
    try {
      candidate = computerProviderImage?.get();
    } catch {
      // A stale image boundary must not block unrelated model traffic.
      candidate = undefined;
    }
    const injected = appendProviderImage(providerMessages, candidate);
    providerMessages = injected.messages;
    if (injected.presented !== undefined) {
      // Mark only after an exact converted tool result received the copy. A
      // mark failure rejects conversion, so this logical decision retries with
      // the same retained bytes instead of sending an unauthorizable image.
      computerProviderImage?.presented(injected.presented);
    }

    let active: Array<{ id: string; text: string }>;
    try {
      active = getLoopList().items
        .filter((item) => item.status === "active")
        .map(({ id, text }) => ({ id, text }));
      if (active.length === 0) return providerMessages;
    } catch {
      // Active work is the admission boundary for the LoopList hint only.
      return providerMessages;
    }

    let elapsedMinutes: LoopListElapsedMinutes | undefined;
    if (getLoopListElapsedMinutes) {
      try {
        elapsedMinutes = getLoopListElapsedMinutes();
      } catch {
        // The active-work reminder remains useful without this optional fact.
      }
    }
    let editBudgetRemainingFiles: number | undefined;
    if (getEditBudgetRemainingFiles) {
      try {
        editBudgetRemainingFiles = getEditBudgetRemainingFiles();
      } catch {
        // The active-work reminder remains useful without this optional fact.
      }
    }
    const workHint = createWorkHint(
      active,
      elapsedMinutes,
      editBudgetRemainingFiles,
    );

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

    const providerTail = telemetry ? `${telemetry}\n${workHint}` : workHint;
    return appendProviderTail(providerMessages, providerTail);
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
