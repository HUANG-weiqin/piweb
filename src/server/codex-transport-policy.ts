import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

type TransportPolicyModel = Pick<Model<Api>, "provider" | "api">;

export function applyCodexAutoTransportPolicy(
  settings: SettingsManager,
  model: TransportPolicyModel,
): void {
  if (
    model.provider === "openai-codex"
    && model.api === "openai-codex-responses"
    && settings.getTransport() === "auto"
  ) {
    settings.applyOverrides({ transport: "sse" });
  }
}
