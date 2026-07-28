// Codex upstream retries stop buffering requests around 1 MiB. AgentContext
// JSON is a conservative pre-request proxy; keep 128 KiB for provider framing.
export const CODEX_CONTEXT_SAFETY_BYTES = 896 * 1024;
export const COMPACTION_RETRY_GROWTH_BYTES = 64 * 1024;

interface ProviderModel {
  provider?: unknown;
  api?: unknown;
}

export function measureSerializedContextBytes(
  context: unknown,
): number | undefined {
  try {
    const serialized = JSON.stringify(context);
    return serialized === undefined
      ? undefined
      : Buffer.byteLength(serialized, "utf8");
  } catch {
    return undefined;
  }
}

export function hasCodexContextBytePressure(
  model: ProviderModel | undefined,
  serializedContextBytes: number | undefined,
): boolean {
  return model?.provider === "openai-codex"
    && model.api === "openai-codex-responses"
    && serializedContextBytes !== undefined
    && serializedContextBytes >= CODEX_CONTEXT_SAFETY_BYTES;
}
