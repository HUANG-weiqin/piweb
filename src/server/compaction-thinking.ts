import { clampThinkingLevel, type Transport } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { isCodexResponsesModel } from "./codex-transport-policy.js";

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
  transport: Transport,
): CompactionThinkingOverride {
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
      const reasoning = clampThinkingLevel(
        model,
        COMPACTION_THINKING_TARGET,
      );
      return capturedStream(model, context, {
        ...options,
        reasoning: reasoning === "off" ? undefined : reasoning,
        ...(isCodexResponsesModel(model) ? { transport } : {}),
      });
    };
    session.agent.streamFunction = overrideStream;
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start") {
      const startedGeneration = ++generation;
      if (event.reason === "manual") {
        // Manual compact emits start before choosing its auth path. Deferring
        // preserves the SDK's streamSimple identity check; its auth await still
        // yields before the summarizer reads agent.streamFunction.
        queueMicrotask(() => {
          if (generation === startedGeneration) install();
        });
      } else {
        // SDK auto-compaction resolves auth before emitting start and can read
        // streamFunction synchronously afterwards.
        install();
      }
    } else if (event.type === "compaction_end") {
      generation++;
      restore();
    }
  });

  return {
    dispose(): void {
      generation++;
      unsubscribe();
      restore();
    },
  };
}
