import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface CompactionBoundaryAdapter {
  dispose(): void;
}

function findEarlierToolCall(
  branch: readonly SessionEntry[],
  resultIndex: number,
  toolCallId: string,
): number {
  for (let index = resultIndex - 1; index >= 0; index--) {
    const entry = branch[index];
    if (
      entry.type !== "message"
      || entry.message.role !== "assistant"
      || !Array.isArray(entry.message.content)
    ) {
      continue;
    }
    if (entry.message.content.some((part) => (
      part.type === "toolCall" && part.id === toolCallId
    ))) {
      return index;
    }
  }
  return -1;
}

function safeFirstKeptEntryId(
  manager: SessionManager,
  proposedEntryId: string,
): string {
  const branch = manager.getBranch();
  let boundaryIndex = branch.findIndex((entry) => entry.id === proposedEntryId);
  if (boundaryIndex < 0) {
    throw new Error(
      `Compaction boundary entry "${proposedEntryId}" is not on the active branch`,
    );
  }

  while (true) {
    let nextBoundaryIndex = boundaryIndex;
    for (let index = boundaryIndex; index < branch.length; index++) {
      const entry = branch[index];
      if (entry.type !== "message" || entry.message.role !== "toolResult") {
        continue;
      }
      const callIndex = findEarlierToolCall(
        branch,
        index,
        entry.message.toolCallId,
      );
      if (callIndex < 0) {
        throw new Error(
          `Tool result "${entry.message.toolCallId}" has no strictly earlier assistant toolCall on the active branch`,
        );
      }
      nextBoundaryIndex = Math.min(nextBoundaryIndex, callIndex);
    }
    if (nextBoundaryIndex === boundaryIndex) {
      return branch[boundaryIndex].id;
    }
    boundaryIndex = nextBoundaryIndex;
  }
}

/**
 * Keeps Pi compaction boundaries from retaining a tool result without the
 * assistant message that issued its tool call.
 */
export function installCompactionBoundary(
  manager: SessionManager,
): CompactionBoundaryAdapter {
  const originalOwnDescriptor = Object.getOwnPropertyDescriptor(
    manager,
    "appendCompaction",
  );
  const original = manager.appendCompaction;
  const wrapped: SessionManager["appendCompaction"] = function (
    summary,
    firstKeptEntryId,
    tokensBefore,
    details,
    fromHook,
    usage,
  ) {
    return original.call(
      manager,
      summary,
      safeFirstKeptEntryId(manager, firstKeptEntryId),
      tokensBefore,
      details,
      fromHook,
      usage,
    );
  };

  Object.defineProperty(manager, "appendCompaction", {
    configurable: originalOwnDescriptor?.configurable ?? true,
    enumerable: originalOwnDescriptor?.enumerable ?? false,
    writable: originalOwnDescriptor && "writable" in originalOwnDescriptor
      ? originalOwnDescriptor.writable
      : true,
    value: wrapped,
  });

  let installed = true;
  return {
    dispose(): void {
      if (!installed) return;
      installed = false;
      const currentDescriptor = Object.getOwnPropertyDescriptor(
        manager,
        "appendCompaction",
      );
      if (
        !currentDescriptor
        || !("value" in currentDescriptor)
        || currentDescriptor.value !== wrapped
      ) {
        return;
      }
      if (originalOwnDescriptor) {
        Object.defineProperty(
          manager,
          "appendCompaction",
          originalOwnDescriptor,
        );
      } else {
        delete (manager as Partial<SessionManager>).appendCompaction;
      }
    },
  };
}
