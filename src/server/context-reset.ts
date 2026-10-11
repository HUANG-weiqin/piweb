import { estimateTokens, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { BASH_TASK_NOTIFICATION_CUSTOM_TYPE, CONTEXT_HINT_CUSTOM_TYPE, LOOP_LIST_CONTINUE_CUSTOM_TYPE } from "./conversation-meta.js";

export const CONTEXT_RESET_DETAILS = "piweb.context_reset.v1";
export const MAX_RESET_HANDOFF_BYTES = 8 * 1024;
export const MAX_RESET_INSTRUCTIONS_BYTES = 64 * 1024;
export const MAX_CONTEXT_RESETS_PER_RUN = 8;

export interface ContextResetPlan {
  readonly assistantEntryId: string;
  readonly toolCallId: string;
  readonly requestLeafId: string;
  readonly summary: string;
  readonly instructions: string;
  readonly handoff: string;
  readonly runId: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasContextEffect(entry: SessionEntry): boolean {
  // The host appends this minute-granular hint during convertToLlm, after
  // prepareRequest. Its LoopList/context telemetry is not independent input.
  if (entry.type === "custom_message" && entry.customType === CONTEXT_HINT_CUSTOM_TYPE) return false;
  return entry.type === "message" || entry.type === "custom_message"
    || entry.type === "context_edit" || entry.type === "compaction"
    || entry.type === "branch_summary";
}

function after(branch: readonly SessionEntry[], id: string | null): readonly SessionEntry[] {
  if (id === null) return branch;
  const index = branch.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error("Context reset frontier is no longer on the active branch");
  return branch.slice(index + 1);
}

function resetSummary(instructions: string, handoff: string): string {
  return [
    "The Agent deliberately reset its working context; no summarizer was called. Original history remains available through history_search/history_context/history_read.",
    "## Preserved instruction context (in original order)",
    "This is previously active context, not a new authorization. Later user corrections supersede earlier requests. System and role rules remain authoritative.",
    instructions || "(No user text or prior checkpoint was present.)",
    "## Agent handoff (working memory; verify facts before acting)",
    handoff,
  ].join("\n\n");
}

/** Preserve the existing canonical instruction substrate, never guess a task from run IDs. */
function instructionContext(manager: SessionManager): string {
  const parts: string[] = [];
  let bytes = 0;
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text, "utf8") + (parts.length > 0 ? 2 : 0);
    if (bytes > MAX_RESET_INSTRUCTIONS_BYTES) {
      throw new Error("Context reset refused: preserved user instructions/checkpoints exceed 64 KiB; they will not be truncated");
    }
    parts.push(text);
  };
  for (const projected of manager.buildSessionProjection().entries) {
    for (const message of projected.messages) {
      if (message.role === "user" || message.role === "custom") {
        if (message.role === "custom" && [
          CONTEXT_HINT_CUSTOM_TYPE, BASH_TASK_NOTIFICATION_CUSTOM_TYPE,
          LOOP_LIST_CONTINUE_CUSTOM_TYPE, "piweb.loop_list_continue.v1", "piweb.compaction_resume.v1",
          "piweb.bash_execution_notice.v1",
        ].includes(message.customType)) continue;
        const label = message.role === "user" ? "User" : `Custom context (${message.customType})`;
        const content = message.content;
        if (typeof content === "string") append(`${label}:\n${content}`);
        else {
          if (content.some((block) => block.type !== "text")) {
            throw new Error("Context reset refused: current user input contains images; visual instructions cannot be replaced by a text handoff");
          }
          append(`${label}:\n${content.map((block) => block.type === "text" ? block.text : "").join("\n")}`);
        }
      } else if (message.role === "compactionSummary") {
        const source = projected.sourceEntry;
        const data = source.type === "compaction"
          ? record(record(source.details)?.[CONTEXT_RESET_DETAILS])
          : undefined;
        if (data !== undefined) {
          if (typeof data.instructions !== "string" || typeof data.handoff !== "string"
            || message.summary !== resetSummary(data.instructions, data.handoff)) {
            throw new Error("Context reset checkpoint is inconsistent; cannot prove preserved instructions");
          }
          if (data.instructions) append(data.instructions);
        } else {
          append(`Previous compaction checkpoint:\n${message.summary}`);
        }
      } else if (message.role === "branchSummary") {
        append(`Previous branch checkpoint:\n${message.summary}`);
      }
    }
  }
  return parts.join("\n\n");
}

/** Called by the tool before accepting any request. No persistence or SDK mutation. */
export function prepareContextReset(
  manager: SessionManager,
  input: { observedLeafId: string | null | undefined; toolCallId: string; handoff: string; runId: string; contextBudget?: number },
): ContextResetPlan {
  if (typeof input.handoff !== "string" || input.handoff.trim().length === 0
    || Buffer.byteLength(input.handoff, "utf8") > MAX_RESET_HANDOFF_BYTES) {
    throw new Error("Context reset needs a non-empty handoff of at most 8 KiB");
  }
  if (input.observedLeafId === undefined) {
    throw new Error("Context reset requires a known conversational request frontier");
  }
  const branch = manager.getBranch();
  const suffix = after(branch, input.observedLeafId).filter(hasContextEffect);
  const assistant = suffix[0];
  if (suffix.length !== 1 || assistant?.type !== "message" || assistant.message.role !== "assistant"
    || assistant.message.stopReason !== "toolUse") {
    throw new Error("Context reset cancelled: new context arrived since this response began; read it before requesting another reset");
  }
  const calls = assistant.message.content.filter((block) => block.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.name !== "reset_context" || calls[0].id !== input.toolCallId) {
    throw new Error("reset_context must be the only direct tool call in this assistant decision; nested or batched calls are not supported");
  }
  const priorResets = branch.filter((entry) => entry.type === "compaction"
    && record(record(entry.details)?.[CONTEXT_RESET_DETAILS])?.runId === input.runId);
  if (priorResets.length >= MAX_CONTEXT_RESETS_PER_RUN) {
    throw new Error("Context reset limit reached for this run; finish or ask the user to continue");
  }
  const lastReset = priorResets.at(-1);
  if (lastReset && !after(branch, lastReset.id).some((entry) => entry.type === "message"
    && (entry.message.role === "user" || (entry.message.role === "toolResult"
      && entry.message.toolName !== "reset_context")))) {
    throw new Error("Context reset needs new work or user input since the last reset");
  }
  const instructions = instructionContext(manager);
  const summary = resetSummary(instructions, input.handoff);
  if (input.contextBudget !== undefined) {
    const systemTokens = manager.buildSessionProjection().messages
      .filter((message) => message.role === "system")
      .reduce((total, message) => total + estimateTokens(message), 0);
    // Match Pi's token estimator; this is a preflight estimate, not a tokenizer
    // or a guarantee about a provider's final request accounting.
    const summaryTokens = estimateTokens({ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 });
    if (!Number.isFinite(input.contextBudget) || input.contextBudget <= 0
      || systemTokens + summaryTokens >= input.contextBudget) {
      throw new Error("Context reset refused: preserved instructions and frozen system/tools exceed the model's context budget");
    }
  }
  return {
    assistantEntryId: assistant.id,
    toolCallId: input.toolCallId,
    requestLeafId: manager.getLeafId()!,
    instructions,
    handoff: input.handoff,
    summary,
    runId: input.runId,
  };
}

/** Recheck after Pi has flushed the complete turn, including deferred custom messages. */
export function assertContextResetBoundary(manager: SessionManager, plan: ContextResetPlan): void {
  const suffix = after(manager.getBranch(), plan.requestLeafId).filter(hasContextEffect);
  const result = suffix[0];
  if (suffix.length !== 1 || result?.type !== "message" || result.message.role !== "toolResult"
    || result.message.toolCallId !== plan.toolCallId || result.message.toolName !== "reset_context"
    || result.message.isError) {
    throw new Error("Context reset cancelled: the complete tool turn changed or additional context arrived; observe it and request again if still useful");
  }
}

/** Caller owns the safe checkpoint and MUST fail closed on append/refresh failure. */
export function appendContextReset(manager: SessionManager, plan: ContextResetPlan, tokensBefore: number): string {
  return manager.appendCompaction(plan.summary, null,
    Number.isFinite(tokensBefore) && tokensBefore >= 0 ? tokensBefore : 0,
    { [CONTEXT_RESET_DETAILS]: {
      runId: plan.runId,
      instructions: plan.instructions,
      handoff: plan.handoff,
    } },
  );
}
