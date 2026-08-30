import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  serviceTierSchema,
  type ServiceTier,
} from "../shared/protocol.js";

type ServiceTierCapableModel = {
  provider?: unknown;
  id?: unknown;
  serviceTiers?: unknown;
};

type ServiceTierStreamOptions = SimpleStreamOptions & {
  serviceTier: ServiceTier;
};

export interface ServiceTierOverride {
  dispose(): void;
}

function modelIdentity(model: unknown): string {
  const compatible = model as ServiceTierCapableModel;
  return typeof compatible.provider === "string"
    && typeof compatible.id === "string"
    ? `${compatible.provider}/${compatible.id}`
    : "request model";
}

/**
 * Reads the SDK capability field at one compatibility boundary until the SDK
 * exposes it in its public Model type.
 */
export function modelServiceTiers(
  model: unknown,
): ServiceTier[] | undefined {
  const value = (model as ServiceTierCapableModel).serviceTiers;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.length > serviceTierSchema.options.length
  ) {
    throw new Error(
      `Model ${modelIdentity(model)} has an invalid serviceTiers capability`,
    );
  }

  const tiers: ServiceTier[] = [];
  const seen = new Set<ServiceTier>();
  for (const candidate of value) {
    const parsed = serviceTierSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data)) {
      throw new Error(
        `Model ${modelIdentity(model)} has an invalid serviceTiers capability`,
      );
    }
    seen.add(parsed.data);
    tiers.push(parsed.data);
  }
  return tiers;
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

/**
 * Validates and injects the live conversation selection at Pi's session-local
 * stream boundary. The same boundary is used for normal turns, tool loops,
 * and compaction requests.
 */
export function installServiceTierOverride(
  session: AgentSession,
  getServiceTier: () => ServiceTier | null,
): ServiceTierOverride {
  let originalStream: typeof session.agent.streamFunction | undefined;
  let overrideStream: typeof session.agent.streamFunction | undefined;
  let generation = 0;

  const restore = (): void => {
    if (originalStream && session.agent.streamFunction === overrideStream) {
      session.agent.streamFunction = originalStream;
    }
    originalStream = undefined;
    overrideStream = undefined;
  };

  const install = (): void => {
    if (originalStream) return;
    originalStream = session.agent.streamFunction;
    const capturedStream = originalStream;
    overrideStream = (model, context, options) => {
      const tier = getServiceTier();
      if (tier === null) return capturedStream(model, context, options);

      assertModelSupportsServiceTier(model, tier);
      const nextOptions: ServiceTierStreamOptions = {
        ...options,
        serviceTier: tier,
      };
      return capturedStream(model, context, nextOptions);
    };
    session.agent.streamFunction = overrideStream;
  };

  install();
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "compaction_start" || event.reason !== "manual") return;

    // Pi chooses manual compaction auth immediately after this synchronous
    // event by checking streamSimple identity. Temporarily expose the original
    // stream, then reinstall before the summarizer reads streamFunction.
    const startedGeneration = ++generation;
    restore();
    queueMicrotask(() => {
      if (generation === startedGeneration) install();
    });
  });

  return {
    dispose(): void {
      generation++;
      unsubscribe();
      restore();
    },
  };
}
