import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { installContextCompression } from "./context-compression.js";

function largeOutput(prefix: string): string {
  return Array.from(
    { length: 160 },
    (_, index) => `${prefix} ${String(index).padStart(3, "0")} ${"x".repeat(100)}`,
  ).join("\n");
}

function toolResult(toolName: string, content: ToolResultMessage["content"]): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${toolName}`,
    toolName,
    content,
    isError: false,
    timestamp: 1,
  };
}

function sessionWithTransform(
  transformContext?: AgentSession["agent"]["transformContext"],
): AgentSession {
  return {
    agent: { transformContext },
  } as AgentSession;
}

describe("context compression", () => {
  it("compresses only bash and grep text parts without changing the original transcript", async () => {
    const bashText = largeOutput("bash");
    const grepText = largeOutput("grep");
    const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
    const bash = toolResult("bash", [{ type: "text", text: bashText }, image]);
    const grep = toolResult("grep", [{ type: "text", text: grepText }]);
    const read = toolResult("read", [{ type: "text", text: bashText }]);
    const write = toolResult("write", [{ type: "text", text: grepText }]);
    const messages = [bash, grep, read, write];
    const session = sessionWithTransform();

    installContextCompression(session);
    const projected = await session.agent.transformContext!(messages);

    expect(projected).not.toBe(messages);
    expect(projected[0]).not.toBe(bash);
    expect(projected[1]).not.toBe(grep);
    expect(projected[2]).toBe(read);
    expect(projected[3]).toBe(write);
    expect((projected[0] as ToolResultMessage).content[0]).not.toBe(bash.content[0]);
    expect((projected[0] as ToolResultMessage).content[1]).toBe(image);
    expect((projected[0] as ToolResultMessage).content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("[... omitted"),
    });
    expect((projected[1] as ToolResultMessage).content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("[... omitted"),
    });
    expect(bash.content[0]).toEqual({ type: "text", text: bashText });
    expect(grep.content[0]).toEqual({ type: "text", text: grepText });
    expect(read.content[0]).toEqual({ type: "text", text: bashText });
    expect(write.content[0]).toEqual({ type: "text", text: grepText });
  });

  it("keeps the extension result array when nothing changes", async () => {
    const messages = [toolResult("bash", [{ type: "text", text: "small output" }])];
    const extensionTransform = vi.fn(async () => messages);
    const session = sessionWithTransform(extensionTransform);

    installContextCompression(session);
    const projected = await session.agent.transformContext!(messages);

    expect(extensionTransform).toHaveBeenCalledWith(messages, undefined);
    expect(projected).toBe(messages);
  });

  it("propagates an extension transform rejection unchanged", async () => {
    const failure = new Error("extension transform failed");
    const session = sessionWithTransform(async () => {
      throw failure;
    });

    installContextCompression(session);

    await expect(session.agent.transformContext!([])).rejects.toBe(failure);
  });

  it("forwards the abort signal to the existing transform", async () => {
    const messages = [toolResult("bash", [{ type: "text", text: "small output" }])];
    const extensionTransform = vi.fn(async () => messages);
    const session = sessionWithTransform(extensionTransform);
    const controller = new AbortController();

    installContextCompression(session);
    await session.agent.transformContext!(messages, controller.signal);

    expect(extensionTransform).toHaveBeenCalledWith(messages, controller.signal);
  });

  it("runs the existing transform first and compresses its result", async () => {
    const input = [toolResult("read", [{ type: "text", text: "input" }])];
    const extensionOutput = [
      toolResult("grep", [{ type: "text", text: largeOutput("extension") }]),
    ];
    const extensionTransform = vi.fn(async () => extensionOutput);
    const session = sessionWithTransform(extensionTransform);

    installContextCompression(session);
    const projected = await session.agent.transformContext!(input);

    expect(extensionTransform).toHaveBeenCalledWith(input, undefined);
    expect(projected).not.toBe(extensionOutput);
    expect((projected[0] as ToolResultMessage).content[0]).toEqual({
      type: "text",
      text: expect.stringContaining("[... omitted"),
    });
    expect(extensionOutput[0]!.content[0]).toEqual({
      type: "text",
      text: largeOutput("extension"),
    });
  });

  it("falls back to the extension result when host projection fails", async () => {
    const extensionOutput = [toolResult("bash", [{ type: "text", text: "unused" }])];
    Object.defineProperty(extensionOutput[0], "content", {
      enumerable: true,
      get: () => {
        throw new Error("unreadable content");
      },
    });
    const session = sessionWithTransform(async () => extensionOutput);

    installContextCompression(session);

    await expect(session.agent.transformContext!([])).resolves.toBe(extensionOutput);
  });
});
