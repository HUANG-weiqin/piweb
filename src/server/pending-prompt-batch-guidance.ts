import {
  MAX_PENDING_PROMPTS_PER_CONVERSATION,
  MAX_PROMPT_CHARACTERS,
} from "../shared/protocol.js";

const PENDING_PROMPT_BATCH_HOST_INSTRUCTION =
  "以下消息属于同一批，请作为整体处理。";

export interface PendingPromptBatchGuidance {
  batchId: string;
  texts: string[];
}

/**
 * Encodes several pending prompts as one user-guidance unit for one SDK steer.
 * The JSON array preserves the durable FIFO order and every original boundary.
 */
export function createPendingPromptBatchGuidance(
  batchId: string,
  texts: readonly string[],
): string {
  if (
    !Array.isArray(texts)
    || texts.length === 0
    || texts.length > MAX_PENDING_PROMPTS_PER_CONVERSATION
  ) {
    throw new Error(
      `Pending prompt batch must contain 1 to ${MAX_PENDING_PROMPTS_PER_CONVERSATION} texts`,
    );
  }
  for (const text of texts) {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("Pending prompt batch texts must not be empty");
    }
    if (text.trimStart().startsWith("/")) {
      throw new Error(
        "Pending prompt batch cannot include slash-command text",
      );
    }
  }
  const guidance = JSON.stringify({
    hostInstruction: PENDING_PROMPT_BATCH_HOST_INSTRUCTION,
    batchId,
    items: texts.map((text, index) => ({ ordinal: index + 1, text })),
  });
  if (guidance.length > MAX_PROMPT_CHARACTERS) {
    throw new Error(
      `Pending prompt batch guidance exceeds ${MAX_PROMPT_CHARACTERS} characters`,
    );
  }
  return guidance;
}

/** Decodes only the exact canonical envelope emitted by this host. */
export function parsePendingPromptBatchGuidance(
  value: string,
): PendingPromptBatchGuidance | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  const envelope = parsed as Record<string, unknown>;
  if (
    envelope.hostInstruction !== PENDING_PROMPT_BATCH_HOST_INSTRUCTION
    || typeof envelope.batchId !== "string"
    || !Array.isArray(envelope.items)
  ) {
    return;
  }
  const texts: string[] = [];
  for (let index = 0; index < envelope.items.length; index += 1) {
    const item = envelope.items[index];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const record = item as Record<string, unknown>;
    if (record.ordinal !== index + 1 || typeof record.text !== "string") {
      return;
    }
    texts.push(record.text);
  }
  try {
    if (createPendingPromptBatchGuidance(envelope.batchId, texts) !== value) {
      return;
    }
  } catch {
    return;
  }
  return { batchId: envelope.batchId, texts };
}

/** Keeps host correlation metadata out of the user-visible transcript. */
export function pendingPromptBatchDisplayText(texts: readonly string[]): string {
  return texts.join("\n\n");
}
