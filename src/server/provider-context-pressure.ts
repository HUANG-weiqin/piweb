// Codex upstream retries stop buffering requests around 1 MiB. Only the exact
// provider payload is capped here with 128 KiB of headroom. Raw AgentContext is
// deliberately not a trigger: its encoding can substantially overestimate the
// provider body and cause repeated low-token compactions.
export const CODEX_REQUEST_SAFETY_BYTES = 896 * 1024;

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
