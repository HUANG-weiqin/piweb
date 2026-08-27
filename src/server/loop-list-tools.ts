import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  MAX_LOOP_LIST_ITEM_ID_CHARACTERS,
  MAX_LOOP_LIST_ITEMS,
  MAX_LOOP_LIST_ITEM_TEXT_CHARACTERS,
  type LoopList,
} from "../shared/protocol.js";

const itemsSchema = Type.Array(Type.Object({
  id: Type.String({ minLength: 1, maxLength: MAX_LOOP_LIST_ITEM_ID_CHARACTERS }),
  text: Type.String({ minLength: 1, maxLength: MAX_LOOP_LIST_ITEM_TEXT_CHARACTERS }),
  checked: Type.Boolean(),
}, { additionalProperties: false }), { maxItems: MAX_LOOP_LIST_ITEMS });
const writeSchema = Type.Object({ items: itemsSchema }, { additionalProperties: false });
const emptySchema = Type.Object({}, { additionalProperties: false });

export interface LoopListToolService {
  read(): LoopList;
  write(items: LoopList["items"]): LoopList;
  pause(): LoopList;
}

function result(loopList: LoopList) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(loopList) }],
    details: loopList,
  };
}

export function createLoopListTools(service: LoopListToolService): ToolDefinition[] {
  return [
    defineTool({
      name: "todo_read",
      label: "Read LoopList",
      description: "Read the authoritative checkbox list for this conversation.",
      parameters: emptySchema,
      async execute(_toolCallId, input) {
        if (!Check(emptySchema, input)) throw new Error("Invalid todo_read input");
        return result(service.read());
      },
    }),
    defineTool({
      name: "todo_write",
      label: "Write LoopList",
      description: "Replace this conversation's full bounded checkbox list. Preserve stable item IDs for continuing items. Writing arms or resumes unchecked work.",
      promptGuidelines: ["Replace the full list; there are no item-by-item mutation tools."],
      parameters: writeSchema,
      async execute(_toolCallId, input) {
        if (!Check(writeSchema, input)) throw new Error("Invalid todo_write input");
        return result(service.write(input.items));
      },
    }),
    defineTool({
      name: "todo_pause",
      label: "Pause LoopList",
      description: "Pause automatic LoopList continuation while preserving all items and check states.",
      parameters: emptySchema,
      async execute(_toolCallId, input) {
        if (!Check(emptySchema, input)) throw new Error("Invalid todo_pause input");
        return result(service.pause());
      },
    }),
  ];
}
