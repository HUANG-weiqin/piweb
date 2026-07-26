import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_NOTE_CONTENT_BYTES,
  MAX_NOTE_COUNT,
} from "./conversation-notebook.js";
import { createNotebookTools } from "./notebook-tools.js";

interface ToolResult<Details> {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
}

const temporaryDirectories: string[] = [];

async function createStateDir(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "piweb-notebook-tools-"));
  temporaryDirectories.push(cwd);
  const stateDir = join(cwd, ".piweb");
  await mkdir(stateDir);
  return stateDir;
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

async function executeTool<Details>(
  tool: ToolDefinition,
  input: unknown,
): Promise<ToolResult<Details>> {
  return tool.execute(
    "tool-call",
    input as never,
    undefined,
    undefined,
    undefined as never,
  ) as Promise<ToolResult<Details>>;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("createNotebookTools", () => {
  it("exposes only the four narrow notebook schemas", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");

    expect(tools.map((tool) => tool.name)).toEqual([
      "notebook_write",
      "notebook_list",
      "notebook_grep",
      "notebook_read",
    ]);
    expect(Check(toolByName(tools, "notebook_write").parameters, {
      title: "Architecture checkpoint",
      content: "src/server/file.ts:10 - conclusion",
      archived: false,
    })).toBe(true);
    expect(Check(toolByName(tools, "notebook_list").parameters, {
      status: "all",
    })).toBe(true);
    expect(Check(toolByName(tools, "notebook_grep").parameters, {
      pattern: "lease",
      status: "active",
    })).toBe(true);
    expect(Check(toolByName(tools, "notebook_read").parameters, {
      titles: ["Architecture checkpoint"],
    })).toBe(true);

    expect(Check(toolByName(tools, "notebook_write").parameters, {
      title: "Architecture checkpoint",
      tags: ["design"],
    })).toBe(false);
    expect(Check(toolByName(tools, "notebook_grep").parameters, {
      pattern: "lease",
      limit: 10,
    })).toBe(false);
  });

  it("writes, lists, greps, reads, archives, and restores notes", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const list = toolByName(tools, "notebook_list");
    const grep = toolByName(tools, "notebook_grep");
    const read = toolByName(tools, "notebook_read");

    const saved = await executeTool<{
      title: string;
      archived: boolean;
      preview: string;
    }>(write, {
      title: "Deletion lifecycle",
      content: "src/server/project-store.ts:642 deletes the JSONL.\nCascade the notebook sidecar too.",
    });
    expect(saved.details).toMatchObject({
      title: "Deletion lifecycle",
      archived: false,
      preview: "src/server/project-store.ts:642 deletes the JSONL.",
    });
    expect(saved.content[0]?.text).not.toContain("Cascade the notebook sidecar too");

    const active = await executeTool<{
      notes: Array<{ title: string; preview: string; archived: boolean }>;
    }>(list, {});
    expect(active.details.notes).toEqual([
      expect.objectContaining({
        title: "Deletion lifecycle",
        archived: false,
        preview: "src/server/project-store.ts:642 deletes the JSONL.",
      }),
    ]);

    const matches = await executeTool<{
      matches: Array<{ title: string; field: string; line?: number }>;
    }>(grep, { pattern: "CASCADE" });
    expect(matches.details.matches).toEqual([
      expect.objectContaining({
        title: "Deletion lifecycle",
        field: "content",
        line: 2,
      }),
    ]);

    const opened = await executeTool<{
      notes: Array<{ title: string; content: string; archived: boolean }>;
    }>(read, { titles: ["Deletion lifecycle"] });
    expect(opened.details.notes[0]).toMatchObject({
      title: "Deletion lifecycle",
      content: expect.stringContaining("Cascade the notebook sidecar too."),
      archived: false,
    });

    await executeTool(write, {
      title: "Deletion lifecycle",
      archived: true,
    });
    await expect(executeTool<{ notes: unknown[] }>(list, {}))
      .resolves.toMatchObject({ details: { notes: [] } });
    await expect(executeTool<{ notes: unknown[] }>(list, { status: "archived" }))
      .resolves.toMatchObject({
        details: {
          notes: [expect.objectContaining({ title: "Deletion lifecycle" })],
        },
      });
    await expect(executeTool(read, { titles: ["Deletion lifecycle"] }))
      .resolves.toMatchObject({
        details: {
          notes: [expect.objectContaining({ archived: true })],
        },
      });

    await executeTool(write, {
      title: "Deletion lifecycle",
      archived: false,
    });
    await expect(executeTool<{ notes: unknown[] }>(list, {}))
      .resolves.toMatchObject({
        details: {
          notes: [expect.objectContaining({ title: "Deletion lifecycle" })],
        },
      });
  });

  it("isolates notes by conversation id", async () => {
    const stateDir = await createStateDir();
    const first = createNotebookTools(stateDir, "conversation-a");
    const second = createNotebookTools(stateDir, "conversation-b");

    await executeTool(toolByName(first, "notebook_write"), {
      title: "Same title",
      content: "first conversation memory",
    });
    await executeTool(toolByName(second, "notebook_write"), {
      title: "Same title",
      content: "second conversation memory",
    });

    await expect(executeTool(toolByName(first, "notebook_read"), {
      titles: ["Same title"],
    })).resolves.toMatchObject({
      details: {
        notes: [expect.objectContaining({
          content: "first conversation memory",
        })],
      },
    });
    await expect(executeTool(toolByName(second, "notebook_read"), {
      titles: ["Same title"],
    })).resolves.toMatchObject({
      details: {
        notes: [expect.objectContaining({
          content: "second conversation memory",
        })],
      },
    });
  });

  it("bounds read output without exposing a limit parameter", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const read = toolByName(tools, "notebook_read");
    const content = "x".repeat(MAX_NOTE_CONTENT_BYTES);

    await executeTool(write, { title: "First", content });
    await executeTool(write, { title: "Second", content });
    await executeTool(write, { title: "Third", content });

    const opened = await executeTool<{
      notes: Array<{ title: string; content: string; truncated: boolean }>;
      truncated: boolean;
    }>(read, { titles: ["First", "Second", "Third"] });

    expect(opened.details.truncated).toBe(true);
    expect(opened.details.notes.map((note) => note.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(opened.details.notes.every((note) => !note.truncated)).toBe(true);
    expect(opened.content[0]?.text).toContain("output truncated");
    expect(opened.content[0]?.text).not.toContain("# Third");
  });

  it("never commits a notebook file beyond its own reread budget", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const list = toolByName(tools, "notebook_list");
    const escapedContent = "\0".repeat(MAX_NOTE_CONTENT_BYTES);
    let accepted = 0;
    let rejection: unknown;

    for (let index = 0; index < MAX_NOTE_COUNT; index++) {
      try {
        await executeTool(write, {
          title: `Escaped ${index.toString().padStart(3, "0")}`,
          content: escapedContent,
        });
        accepted++;
      } catch (error) {
        rejection = error;
        break;
      }
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toMatch(/file exceeds its safety limit/i);
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(MAX_NOTE_COUNT);
    const listed = await executeTool<{ notes: unknown[] }>(
      list,
      { status: "all" },
    );
    expect(listed.details.notes).toHaveLength(accepted);
  });

  it("requires content for new notes and replaces existing content by title", async () => {
    const stateDir = await createStateDir();
    const tools = createNotebookTools(stateDir, "conversation-a");
    const write = toolByName(tools, "notebook_write");
    const read = toolByName(tools, "notebook_read");

    await expect(executeTool(write, {
      title: "Open question",
      archived: true,
    })).rejects.toThrow(/require content/i);
    await executeTool(write, {
      title: "Open question",
      content: "initial answer",
    });
    await executeTool(write, {
      title: "Open question",
      content: "replacement answer",
    });

    await expect(executeTool(read, { titles: ["Open question"] }))
      .resolves.toMatchObject({
        details: {
          notes: [expect.objectContaining({ content: "replacement answer" })],
        },
      });
  });
});
