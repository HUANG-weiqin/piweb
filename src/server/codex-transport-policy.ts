import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export type TransportPolicyModel = Pick<Model<Api>, "provider" | "api">;

export function isCodexResponsesModel(model: TransportPolicyModel): boolean {
  return (
    model.provider === "openai-codex"
    && model.api === "openai-codex-responses"
  );
}

/**
 * Prefer Codex's zstd-compressed SSE path for workbench-managed auto transport.
 * This is a session-only settings override: transport failures must not be
 * converted into token overflow or durable compaction pressure.
 */
export function applyCodexAutoTransportPolicy(
  settings: SettingsManager,
  model: TransportPolicyModel,
): void {
  if (isCodexResponsesModel(model) && settings.getTransport() === "auto") {
    settings.applyOverrides({ transport: "sse" });
  }
}
