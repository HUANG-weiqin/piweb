import {
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  type ConversationSummary,
} from "../../shared/protocol";

export type ConversationTitleLookup = ReadonlyMap<string, string>;

function shortHandle(conversationId: string): string {
  return `#${conversationId.slice(0, 8)}`;
}

export function conversationDisplayTitle(
  conversation: Pick<ConversationSummary, "name" | "preview">,
): string {
  const title = conversation.name?.trim()
    || conversation.preview.trim()
    || "新会话";
  const characters = [...title];
  if (characters.length <= MAX_PROJECT_CONVERSATION_NAME_CHARACTERS) {
    return title;
  }
  return `${characters
    .slice(0, MAX_PROJECT_CONVERSATION_NAME_CHARACTERS - 1)
    .join("")}…`;
}

function titleEntries(
  conversations: readonly ConversationSummary[],
  conversationIndexTruncated: boolean,
): Array<readonly [string, string]> {
  const baseTitles = conversations.map((conversation) => ({
    id: conversation.id,
    title: conversationDisplayTitle(conversation),
  }));
  const titleCounts = new Map<string, number>();
  for (const { title } of baseTitles) {
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return baseTitles
    .map(({ id, title }) => [
      id,
      !conversationIndexTruncated && titleCounts.get(title) === 1
        ? title
        : `${title} ${shortHandle(id)}`,
    ] as const)
    .sort(([leftId], [rightId]) => (
      leftId === rightId ? 0 : leftId < rightId ? -1 : 1
    ));
}

export function conversationTitleLookupKey(
  projectId: string,
  conversations: readonly ConversationSummary[],
  conversationIndexTruncated: boolean,
): string {
  return JSON.stringify([
    projectId,
    conversationIndexTruncated,
    titleEntries(conversations, conversationIndexTruncated),
  ]);
}

export function createConversationTitleLookup(
  conversations: readonly ConversationSummary[],
  conversationIndexTruncated: boolean,
): ConversationTitleLookup {
  return new Map(titleEntries(conversations, conversationIndexTruncated));
}

export function conversationTargetTitle(
  lookup: ConversationTitleLookup | undefined,
  conversationId: string,
): string {
  return lookup?.get(conversationId)
    ?? `未知会话 ${shortHandle(conversationId)}`;
}
