import {
  clampThinkingLevel,
  type Api,
  type Context,
  type Model,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServiceTier } from "../shared/protocol.js";

const CODEX_RESPONSES_API = "openai-codex-responses" as const;
const CODEX_SERVICE_TIERS = ["priority"] satisfies readonly ServiceTier[];

type ServiceTierRouteModel = {
  provider?: unknown;
  id?: unknown;
  api?: unknown;
};

export interface ServiceTierOverride {
  dispose(): void;
}

function modelIdentity(model: unknown): string {
  const compatible = model as ServiceTierRouteModel;
  return typeof compatible.provider === "string"
    && typeof compatible.id === "string"
    ? `${compatible.provider}/${compatible.id}`
    : "request model";
}

/**
 * Projects the stable request-route capability. Provider account and model
 * eligibility remain authoritative at dispatch and are never guessed here.
 */
export function modelServiceTiers(
  model: unknown,
): ServiceTier[] | undefined {
  return (model as ServiceTierRouteModel).api === CODEX_RESPONSES_API
    ? [...CODEX_SERVICE_TIERS]
    : undefined;
}

export function assertModelSupportsServiceTier(
  model: unknown,
  tier: ServiceTier,
): void {
  if (modelServiceTiers(model)?.includes(tier)) return;
  throw new Error(
    `Model ${modelIdentity(model)} does not support service tier "${tier}"`,
  );
}

type ServiceTierModelRuntime = Pick<
  ModelRuntime,
  "stream" | "streamSimple"
>;

function streamCodexWithServiceTier(
  modelRuntime: ServiceTierModelRuntime,
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions | undefined,
  tier: ServiceTier,
) {
  assertModelSupportsServiceTier(model, tier);

  const codexModel = model as Model<typeof CODEX_RESPONSES_API>;
  const base = {
    ...buildBaseOptions(codexModel, context, options, options?.apiKey),
    toolChoice: options?.toolChoice,
  };
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(codexModel, options.reasoning)
    : undefined;
  const reasoningEffort = clampedReasoning === "off"
    ? undefined
    : clampedReasoning;

  return modelRuntime.stream(codexModel, context, {
    ...base,
    reasoningEffort,
    serviceTier: tier,
    // buildBaseOptions intentionally knows only provider options. Keep the
    // ModelRuntime request transform added by coding-agent around streamSimple.
    transformHeaders: options?.transformHeaders,
  } satisfies ModelsApiStreamOptions<typeof CODEX_RESPONSES_API>);
}

/**
 * Applies the live conversation selection below coding-agent's session stream
 * wrapper. That wrapper still owns settings, attribution, and extension header
 * transforms; Pi's low-level route still owns auth, transport, response, and
 * service-tier cost semantics. Pi Web owns only the missing simple conversion.
 */
export function installServiceTierOverride(
  modelRuntime: ServiceTierModelRuntime,
  getServiceTier: () => ServiceTier | null,
): ServiceTierOverride {
  const hadOwnStreamSimple = Object.hasOwn(modelRuntime, "streamSimple");
  const originalStreamSimple = modelRuntime.streamSimple;
  const overrideStreamSimple: ModelRuntime["streamSimple"] = (
    model,
    context,
    options,
  ) => {
    const tier = getServiceTier();
    if (tier === null) {
      return originalStreamSimple.call(modelRuntime, model, context, options);
    }
    return streamCodexWithServiceTier(
      modelRuntime,
      model,
      context,
      options,
      tier,
    );
  };
  modelRuntime.streamSimple = overrideStreamSimple;

  return {
    dispose(): void {
      if (modelRuntime.streamSimple !== overrideStreamSimple) return;
      if (hadOwnStreamSimple) {
        modelRuntime.streamSimple = originalStreamSimple;
      } else {
        delete (modelRuntime as { streamSimple?: ModelRuntime["streamSimple"] })
          .streamSimple;
      }
    },
  };
}
