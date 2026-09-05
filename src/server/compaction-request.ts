import { clampThinkingLevel, type Transport } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isCodexResponsesModel } from "./codex-transport-policy.js";
import { COMPACTION_SERVICE_TIER_SUPPRESSION } from "./service-tier.js";

const COMPACTION_THINKING_TARGET = "minimal";
const DEFAULT_COMPACTION_ARGUMENT_COUNT = 8;

export interface DefaultCompactionModelReference {
  provider: string;
  id: string;
}

interface CompactionModelRuntime {
  getModel(provider: string, modelId: string): unknown;
}

interface CompactionPrivateSession {
  agent: AgentSession["agent"];
  _runDefaultCompaction?: (...args: unknown[]) => Promise<unknown>;
}

export interface DefaultCompactionRequestOverride {
  dispose(): void;
}

function assertContextWindow(model: unknown, label: string): number {
  const contextWindow = (model as { contextWindow?: unknown }).contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`${label} has an invalid context window`);
  }
  return contextWindow;
}

function assertCompactionModelFits(
  requestModel: unknown,
  compactionModel: unknown,
): void {
  const requestContextWindow = assertContextWindow(requestModel, "Current primary model");
  const compactionContextWindow = assertContextWindow(
    compactionModel,
    "Configured compaction model",
  );
  if (compactionContextWindow < requestContextWindow) {
    throw new Error(
      `Configured compaction model context window (${compactionContextWindow}) is smaller than current primary model context window (${requestContextWindow})`,
    );
  }
}

/**
 * Uses Pi's private default-compaction seam so custom compaction hooks continue
 * to bypass it, while default summaries can use a session-local model request.
 */
export function installDefaultCompactionRequestOverride(
  session: AgentSession,
  modelRuntime: CompactionModelRuntime,
  compactionModelReference?: DefaultCompactionModelReference,
  defaultTransport: Transport = "auto",
): DefaultCompactionRequestOverride {
  const explicitCompactionModel = compactionModelReference
    ? {
        provider: compactionModelReference.provider,
        id: compactionModelReference.id,
      }
    : undefined;
  const privateSession = session as unknown as CompactionPrivateSession;
  const original = privateSession._runDefaultCompaction;
  const ownDescriptor = Object.getOwnPropertyDescriptor(
    privateSession,
    "_runDefaultCompaction",
  );
  if (
    typeof original !== "function"
    || original.length !== DEFAULT_COMPACTION_ARGUMENT_COUNT
    || (ownDescriptor !== undefined && (
      !("value" in ownDescriptor)
      || ownDescriptor.writable !== true
    ))
    || (ownDescriptor === undefined && !Object.isExtensible(privateSession))
  ) {
    throw new Error("Unsupported Pi default compaction implementation");
  }

  let active = false;
  let override: CompactionPrivateSession["_runDefaultCompaction"];

  override = async (...args: unknown[]): Promise<unknown> => {
    if (active) {
      throw new Error("Pi default compaction attempts must not overlap");
    }
    if (args.length !== DEFAULT_COMPACTION_ARGUMENT_COUNT) {
      throw new Error("Unsupported Pi default compaction invocation");
    }

    active = true;
    try {
      const requestArgs = [...args];
      if (explicitCompactionModel) {
        const compactionModel = modelRuntime.getModel(
          explicitCompactionModel.provider,
          explicitCompactionModel.id,
        );
        if (!compactionModel) {
          throw new Error(
            `Configured compaction model ${explicitCompactionModel.provider}/${explicitCompactionModel.id} is unavailable in this session`,
          );
        }
        assertCompactionModelFits(requestArgs[1], compactionModel);
        requestArgs[1] = compactionModel;
        requestArgs[2] = undefined;
        requestArgs[3] = undefined;
        requestArgs[6] = undefined;
      }

      const capturedStream = session.agent.streamFunction;
      const compactionStream: typeof session.agent.streamFunction = (
        model,
        context,
        options,
      ) => {
        const reasoning = clampThinkingLevel(model, COMPACTION_THINKING_TARGET);
        const requestOptions = {
          ...options,
          reasoning: reasoning === "off" ? undefined : reasoning,
          ...(isCodexResponsesModel(model)
            ? {
                transport: (options?.transport ?? defaultTransport) === "auto"
                  ? "sse" as const
                  : options?.transport ?? defaultTransport,
              }
            : {}),
        };
        if (explicitCompactionModel) {
          Object.defineProperty(
            requestOptions,
            COMPACTION_SERVICE_TIER_SUPPRESSION,
            { enumerable: true, value: true },
          );
        }
        return capturedStream(model, context, requestOptions);
      };

      session.agent.streamFunction = compactionStream;
      let result: Promise<unknown>;
      try {
        result = Reflect.apply(original, privateSession, requestArgs);
      } finally {
        if (session.agent.streamFunction === compactionStream) {
          session.agent.streamFunction = capturedStream;
        }
      }
      return await result;
    } finally {
      active = false;
    }
  };

  Object.defineProperty(privateSession, "_runDefaultCompaction", {
    configurable: ownDescriptor?.configurable ?? true,
    enumerable: ownDescriptor?.enumerable ?? false,
    writable: true,
    value: override,
  });

  return {
    dispose(): void {
      if (privateSession._runDefaultCompaction !== override) return;
      if (ownDescriptor) {
        Object.defineProperty(privateSession, "_runDefaultCompaction", ownDescriptor);
      } else {
        delete privateSession._runDefaultCompaction;
      }
    },
  };
}
