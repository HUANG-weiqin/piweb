import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { PublicContextUsage } from "../shared/protocol.js";

interface NativeContextUsage {
  tokens: number | null;
  contextWindow: number | null;
}

function usagePercent(tokens: number, contextWindow: number | null): number | null {
  return contextWindow !== null && contextWindow > 0
    ? (tokens / contextWindow) * 100
    : null;
}

export function resolveContextUsage({
  contextWindow,
  messages,
  nativeUsage,
}: {
  contextWindow: number | null;
  messages?: readonly unknown[];
  nativeUsage?: NativeContextUsage;
}): PublicContextUsage {
  const window = contextWindow ?? nativeUsage?.contextWindow ?? null;

  if (nativeUsage) {
    if (nativeUsage.tokens === null) {
      return {
        tokens: null,
        contextWindow: window,
        percent: null,
        source: "unknown",
      };
    }

    return {
      tokens: nativeUsage.tokens,
      contextWindow: window,
      percent: usagePercent(nativeUsage.tokens, window),
      source: "measured",
    };
  }

  const tokens = (messages ?? []).reduce<number>(
    (total, message) => total + estimateTokens(message as Parameters<typeof estimateTokens>[0]),
    0,
  );
  return {
    tokens,
    contextWindow: window,
    percent: usagePercent(tokens, window),
    source: "estimated",
  };
}
