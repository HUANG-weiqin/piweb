import type { ThinkingLevel } from "../shared/protocol.js";

export interface ThinkingCapableModel {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function supportedThinkingLevels(
  model: ThinkingCapableModel,
): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => (
    model.thinkingLevelMap?.[level] !== null
  ));
}
