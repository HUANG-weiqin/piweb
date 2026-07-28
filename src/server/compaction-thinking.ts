import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type AgentProviderPayloadHandler,
  type AgentProviderPayloadHook,
  wrapAgentProviderPayloadHandler,
} from "./agent-provider-payload.js";

const COMPACTION_THINKING_TARGET = "minimal";

export interface CompactionThinkingOverride {
  dispose(): void;
}

/**
 * Applies a lower reasoning level only while Pi is issuing compaction model
 * requests, without changing the conversation's model or thinking state.
 */
export function installCompactionThinkingOverride(
  session: AgentSession,
  providerPayloadHandler?: AgentProviderPayloadHandler,
): CompactionThinkingOverride {
  let originalStream: typeof session.agent.streamFn | undefined;
  let overrideStream: typeof session.agent.streamFn | undefined;
  let generation = 0;
  let disposed = false;

  const restore = (): void => {
    if (originalStream && session.agent.streamFn === overrideStream) {
      session.agent.streamFn = originalStream;
    }
    originalStream = undefined;
    overrideStream = undefined;
  };

  const install = (): void => {
    if (originalStream || disposed) return;
    originalStream = session.agent.streamFn;
    const capturedStream = originalStream;
    overrideStream = (model, context, options) => {
      const reasoning = clampThinkingLevel(
        model,
        COMPACTION_THINKING_TARGET,
      );
      const guardedOnPayload = providerPayloadHandler
        ? wrapAgentProviderPayloadHandler(
            options?.onPayload as AgentProviderPayloadHook | undefined,
            providerPayloadHandler,
          )
        : options?.onPayload;
      return capturedStream(model, context, {
        ...options,
        reasoning: reasoning === "off" ? undefined : reasoning,
        ...(guardedOnPayload ? { onPayload: guardedOnPayload } : {}),
      });
    };
    session.agent.streamFn = overrideStream;
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start") {
      const startedGeneration = ++generation;
      if (event.reason === "manual") {
        // Manual compact emits start before choosing its auth path. Deferring
        // preserves the SDK's streamSimple identity check; its auth await still
        // yields before the summarizer reads agent.streamFn.
        queueMicrotask(() => {
          if (generation === startedGeneration) install();
        });
      } else {
        // SDK auto-compaction resolves auth before emitting start and can read
        // streamFn synchronously afterwards.
        install();
      }
    } else if (event.type === "compaction_end") {
      generation++;
      restore();
    }
  });

  return {
    dispose(): void {
      disposed = true;
      generation++;
      unsubscribe();
      restore();
    },
  };
}
