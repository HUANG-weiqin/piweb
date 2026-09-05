import {
  clampThinkingLevel,
  type Api,
  type Context,
  type Model,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServiceTier } from "../shared/protocol.js";

const CODEX_RESPONSES_API = "openai-codex-responses" as const;
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_BACKEND = "https://chatgpt.com/backend-api";
const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
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

/** Mirrors the first-party OAuth backend hint without leaking it to custom routes. */
function openAICodexRoutingHint(
  model: Model<Api>,
  tier: ServiceTier | null,
): string | null {
  if (
    model.provider !== OPENAI_CODEX_PROVIDER
    || model.api !== CODEX_RESPONSES_API
    || model.baseUrl.replace(/\/+$/u, "") !== OPENAI_CODEX_BACKEND
  ) {
    return null;
  }
  return `model=${model.id}${tier === null ? "" : `;tier=${tier}`}`;
}

function withRoutingHint(
  options: ModelsSimpleStreamOptions | undefined,
  hint: string,
): ModelsSimpleStreamOptions {
  const headers = { ...options?.headers };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === CODEX_ROUTING_HINT_HEADER) {
      delete headers[name];
    }
  }
  headers[CODEX_ROUTING_HINT_HEADER] = hint;
  return { ...options, headers };
}

function streamCodexWithServiceTier(
  modelRuntime: ServiceTierModelRuntime,
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions | undefined,
  tier: ServiceTier,
) {
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
 * service-tier cost semantics. Pi Web owns the missing simple conversion and
 * the Codex OAuth routing hint until the provider supplies both itself.
 */
export function installServiceTierOverride(
  modelRuntime: ServiceTierModelRuntime,
  getServiceTier: () => ServiceTier | null,
): ServiceTierOverride {
  const hadOwnStreamSimple = Object.hasOwn(modelRuntime, "streamSimple");
  const originalStreamSimple = modelRuntime.streamSimple;
  // PiRuntime owns one ModelRuntime per AgentSession.
  let lastRoutingHint: string | null | undefined;
  const overrideStreamSimple: ModelRuntime["streamSimple"] = (
    model,
    context,
    options,
  ) => {
    const tier = getServiceTier();
    if (tier !== null) assertModelSupportsServiceTier(model, tier);

    const routingHint = openAICodexRoutingHint(model, tier);
    const sessionId = options?.sessionId;
    if (sessionId) {
      if (
        lastRoutingHint !== undefined
        && lastRoutingHint !== routingHint
      ) {
        // The Codex WebSocket cache does not include routing headers in its key.
        closeOpenAICodexWebSocketSessions(sessionId);
      }
      lastRoutingHint = routingHint;
    }
    const routedOptions = routingHint === null
      ? options
      : withRoutingHint(options, routingHint);

    if (tier === null) {
      return originalStreamSimple.call(
        modelRuntime,
        model,
        context,
        routedOptions,
      );
    }
    return streamCodexWithServiceTier(
      modelRuntime,
      model,
      context,
      routedOptions,
      tier,
    );
  };
  modelRuntime.streamSimple = overrideStreamSimple;

  return {
    dispose(): void {
      lastRoutingHint = undefined;
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
