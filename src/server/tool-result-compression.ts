import { compressLineStream } from "@piweb/context-compressor";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type AfterToolCall = NonNullable<AgentSession["agent"]["afterToolCall"]>;
type ToolResultContent = Parameters<AfterToolCall>[0]["result"]["content"];

function compressToolResultContent(content: ToolResultContent): ToolResultContent {
  let projectedContent: ToolResultContent | undefined;

  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (part.type !== "text") continue;

    const text = compressLineStream(part.text);
    if (text === part.text) continue;

    projectedContent ??= content.slice();
    projectedContent[index] = { ...part, text };
  }

  return projectedContent ?? content;
}

/**
 * Compresses selected finalized tool results before Pi emits and persists them.
 */
export function installToolResultCompression(session: AgentSession): void {
  const extensionAfterToolCall = session.agent.afterToolCall;
  session.agent.afterToolCall = async (context, signal) => {
    const extensionPatch = await extensionAfterToolCall?.(context, signal);
    try {
      if (context.toolCall.name !== "bash" && context.toolCall.name !== "grep") {
        return extensionPatch;
      }

      const content = extensionPatch?.content ?? context.result.content;
      const projectedContent = compressToolResultContent(content);
      if (projectedContent === content) return extensionPatch;
      return { ...extensionPatch, content: projectedContent };
    } catch {
      return extensionPatch;
    }
  };
}
