import type { PublicProvider } from "../shared/protocol.js";
import {
  supportedThinkingLevels,
  type ThinkingCapableModel,
} from "./model-thinking.js";

interface ModelLike extends ThinkingCapableModel {
  provider: string;
  id: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
}

interface ProviderProjectionInput {
  models: ModelLike[];
  availableKeys: Set<string>;
  oauthProviders: Map<string, string>;
  displayName(provider: string): string;
  authStatus(provider: string): { configured: boolean; source?: string; label?: string };
}

export function buildPublicProviders(input: ProviderProjectionInput): PublicProvider[] {
  const grouped = new Map<string, ModelLike[]>();
  for (const model of input.models) {
    const list = grouped.get(model.provider) ?? [];
    list.push(model);
    grouped.set(model.provider, list);
  }

  for (const id of input.oauthProviders.keys()) {
    if (!grouped.has(id)) grouped.set(id, []);
  }

  return [...grouped.entries()]
    .map(([id, models]) => {
      const status = input.authStatus(id);
      return {
        id,
        name: input.oauthProviders.get(id) ?? input.displayName(id),
        configured: status.configured,
        authSource: status.source,
        authLabel: status.label,
        oauth: input.oauthProviders.has(id),
        models: models
          .map((model) => ({
            provider: id,
            id: model.id,
            name: model.name ?? model.id,
            reasoning: model.reasoning ?? false,
            thinkingLevels: supportedThinkingLevels(model),
            input: model.input ?? ["text"],
            contextWindow: model.contextWindow ?? 0,
            available: input.availableKeys.has(`${id}/${model.id}`),
          }))
          .sort((a, b) => Number(b.available) - Number(a.available) || a.id.localeCompare(b.id)),
      } satisfies PublicProvider;
    })
    .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
}
