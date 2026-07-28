// Codex upstream retries stop buffering requests around 1 MiB. The exact
// provider payload is capped here with 128 KiB of headroom. Raw AgentContext
// uses the same threshold only as an early heuristic because provider
// conversion and extension transforms can expand or shrink the final body.
export const CODEX_REQUEST_SAFETY_BYTES = 896 * 1024;
export const COMPACTION_RETRY_GROWTH_BYTES = 64 * 1024;

interface ProviderModel {
  provider?: unknown;
  api?: unknown;
}

export function isCodexResponsesModel(
  model: ProviderModel | undefined,
): boolean {
  return model?.provider === "openai-codex"
    && model.api === "openai-codex-responses";
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
  return isCodexResponsesModel(model)
    && serializedContextBytes !== undefined
    && serializedContextBytes >= CODEX_REQUEST_SAFETY_BYTES;
}

export function codexPayloadPressureError(
  model: ProviderModel | undefined,
  serializedPayloadBytes: number | undefined,
): string | undefined {
  if (!isCodexResponsesModel(model)) return undefined;
  if (
    serializedPayloadBytes !== undefined
    && serializedPayloadBytes < CODEX_REQUEST_SAFETY_BYTES
  ) return undefined;

  const size = serializedPayloadBytes === undefined
    ? "an unmeasurable size"
    : `${serializedPayloadBytes} bytes`;
  return "context_length_exceeded: Pi Web stopped an openai-codex request "
    + `with ${size} before transport so Pi can attempt compaction safely`;
}
