import { compressLineStream } from "@piweb/context-compressor";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type ContextMessages = Parameters<
  NonNullable<AgentSession["agent"]["transformContext"]>
>[0];

function compressToolResultMessages(messages: ContextMessages): ContextMessages {
  let projected: ContextMessages | undefined;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (
      message.role !== "toolResult"
      || (message.toolName !== "bash" && message.toolName !== "grep")
    ) {
      continue;
    }

    let projectedContent: typeof message.content | undefined;
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
      const part = message.content[contentIndex];
      if (part.type !== "text") continue;

      const text = compressLineStream(part.text);
      if (text === part.text) continue;

      projectedContent ??= message.content.slice();
      projectedContent[contentIndex] = { ...part, text };
    }
    if (!projectedContent) continue;

    projected ??= messages.slice();
    projected[messageIndex] = { ...message, content: projectedContent };
  }

  return projected ?? messages;
}

/**
 * Projects selected tool output only for ordinary Agent-turn provider calls.
 * Session history remains unchanged; compaction summaries use durable originals.
 */
export function installContextCompression(session: AgentSession): void {
  const extensionTransformContext = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const extensionMessages = extensionTransformContext
      ? await extensionTransformContext(messages, signal)
      : messages;
    try {
      return compressToolResultMessages(extensionMessages);
    } catch {
      return extensionMessages;
    }
  };
}
