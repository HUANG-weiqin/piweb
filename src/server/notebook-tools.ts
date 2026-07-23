import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  ConversationNotebook,
  MAX_NOTE_CONTENT_BYTES,
  MAX_NOTE_TITLE_CHARS,
  MAX_NOTEBOOK_READ_TITLES,
  notebookResultText,
  type NotebookStatus,
} from "./conversation-notebook.js";

const statusSchema = Type.Optional(Type.String({
  enum: ["active", "archived", "all"],
}));

const notebookWriteParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: MAX_NOTE_TITLE_CHARS }),
  content: Type.Optional(Type.String({ maxLength: MAX_NOTE_CONTENT_BYTES })),
  archived: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const notebookListParameters = Type.Object({
  status: statusSchema,
}, { additionalProperties: false });

const notebookGrepParameters = Type.Object({
  pattern: Type.String({ minLength: 1, maxLength: 256 }),
  status: statusSchema,
}, { additionalProperties: false });

const notebookReadParameters = Type.Object({
  titles: Type.Array(
    Type.String({ minLength: 1, maxLength: MAX_NOTE_TITLE_CHARS }),
    { minItems: 1, maxItems: MAX_NOTEBOOK_READ_TITLES },
  ),
}, { additionalProperties: false });

type NotebookWriteToolInput = Static<typeof notebookWriteParameters>;
type NotebookListToolInput = Static<typeof notebookListParameters>;
type NotebookGrepToolInput = Static<typeof notebookGrepParameters>;
type NotebookReadToolInput = Static<typeof notebookReadParameters>;

function result(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function assertInput<T>(schema: unknown, rawInput: unknown, toolName: string): asserts rawInput is T {
  if (!Check(schema as never, rawInput)) {
    throw new Error(`Invalid ${toolName} input`);
  }
}

function status(value: string | undefined): NotebookStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "active" || value === "archived" || value === "all") {
    return value;
  }
  throw new Error("Invalid notebook status");
}

export function createNotebookTools(
  stateDir: string,
  conversationId: string,
): ToolDefinition[] {
  const notebook = new ConversationNotebook(stateDir, conversationId);
  return [
    defineTool({
      name: "notebook_write",
      label: "Notebook write",
      description:
        "Write or archive a note in this conversation's compact-resistant Agent Notebook. Title is the stable unique handle; content replaces the whole note; archived toggles visibility without deleting it. Do not store raw logs, large source blocks, or secrets.",
      promptSnippet:
        "Use notebook_write for checkpoints, reusable conclusions, open questions, and source anchors. Choose stable descriptive titles; title is the note handle. Archive obsolete notes.",
      promptGuidelines: [
        "Notebook content is working memory, not truth; re-read source before final citation.",
        "New titles require content. Existing titles are overwritten when content is provided. Use archived=true to archive and archived=false to restore.",
      ],
      parameters: notebookWriteParameters,
      async execute(_toolCallId, rawInput) {
        assertInput<NotebookWriteToolInput>(
          notebookWriteParameters,
          rawInput,
          "notebook_write",
        );
        const details = await notebook.write(rawInput);
        return result(notebookResultText.write(details), details);
      },
    }),
    defineTool({
      name: "notebook_list",
      label: "Notebook list",
      description:
        "List this conversation's Agent Notebook notes by status. Returns titles, previews, archive state, size, and updated time, not full note content.",
      promptSnippet:
        "After compaction or uncertainty, call notebook_list first to rediscover this conversation's working memory.",
      promptGuidelines: [
        "Use status=archived or status=all when an obsolete note may still contain recoverable context.",
        "Use notebook_read only after notebook_list or notebook_grep identifies exact titles.",
      ],
      parameters: notebookListParameters,
      async execute(_toolCallId, rawInput) {
        assertInput<NotebookListToolInput>(
          notebookListParameters,
          rawInput,
          "notebook_list",
        );
        const details = await notebook.list(status(rawInput.status));
        return result(notebookResultText.list(details), details);
      },
    }),
    defineTool({
      name: "notebook_grep",
      label: "Notebook grep",
      description:
        "Case-insensitive literal search over titles and content in this conversation's Agent Notebook. Returns matching snippets, not full notes.",
      promptSnippet:
        "Before repeating broad project reads/searches, call notebook_grep to find prior conclusions and source anchors.",
      promptGuidelines: [
        "Search is literal and case-insensitive, not regex or semantic search.",
        "Read exact titles with notebook_read after grep identifies relevant notes.",
      ],
      parameters: notebookGrepParameters,
      async execute(_toolCallId, rawInput) {
        assertInput<NotebookGrepToolInput>(
          notebookGrepParameters,
          rawInput,
          "notebook_grep",
        );
        const details = await notebook.grep(
          rawInput.pattern,
          status(rawInput.status),
        );
        return result(notebookResultText.grep(details), details);
      },
    }),
    defineTool({
      name: "notebook_read",
      label: "Notebook read",
      description:
        "Read one or more exact-title notes from this conversation's Agent Notebook. Archived notes remain readable by exact title.",
      promptSnippet:
        "Read exact Agent Notebook titles after list/grep identifies them.",
      promptGuidelines: [
        "Do not use notebook_read for discovery; use notebook_list or notebook_grep first.",
        "Notebook content is not authoritative evidence. Re-read source ranges before citing them in final answers.",
      ],
      parameters: notebookReadParameters,
      async execute(_toolCallId, rawInput) {
        assertInput<NotebookReadToolInput>(
          notebookReadParameters,
          rawInput,
          "notebook_read",
        );
        const details = await notebook.read(rawInput.titles);
        return result(notebookResultText.read(details), details);
      },
    }),
  ];
}
