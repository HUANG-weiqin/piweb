import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { installToolResultCompression } from "./tool-result-compression.js";

type AfterToolCall = NonNullable<AgentSession["agent"]["afterToolCall"]>;
type AfterToolCallContext = Parameters<AfterToolCall>[0];
type AfterToolCallPatch = Awaited<ReturnType<AfterToolCall>>;
type ToolResultContent = AfterToolCallContext["result"]["content"];

function largeOutput(prefix: string): string {
  return Array.from(
    { length: 160 },
    (_, index) => `${prefix} ${String(index).padStart(3, "0")} ${"x".repeat(100)}`,
  ).join("\n");
}

function toolResultContext(
  toolName: string,
  content: ToolResultContent,
): AfterToolCallContext {
  return {
    toolCall: { name: toolName },
    result: { content, details: { original: true } },
  } as AfterToolCallContext;
}

function sessionWithAfterToolCall(afterToolCall?: AfterToolCall): AgentSession {
  return {
    agent: { afterToolCall },
  } as AgentSession;
}

describe("tool result compression", () => {
  it("returns direct bash and grep content patches without changing result content", async () => {
    const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
    const bashContent: ToolResultContent = [
      { type: "text", text: largeOutput("bash") },
      image,
    ];
    const grepContent: ToolResultContent = [{ type: "text", text: largeOutput("grep") }];
    const bash = toolResultContext("bash", bashContent);
    const grep = toolResultContext("grep", grepContent);
    const session = sessionWithAfterToolCall();

    installToolResultCompression(session);
    const bashPatch = await session.agent.afterToolCall!(bash);
    const grepPatch = await session.agent.afterToolCall!(grep);

    expect(bashPatch).toEqual({
      content: [
        { type: "text", text: expect.stringContaining("[... omitted") },
        image,
      ],
    });
    expect(grepPatch).toEqual({
      content: [{ type: "text", text: expect.stringContaining("[... omitted") }],
    });
    expect(bashPatch?.content?.[1]).toBe(image);
    expect(bash.result.content).toBe(bashContent);
    expect(grep.result.content).toBe(grepContent);
    expect(bash.result.content[0]).toEqual({ type: "text", text: largeOutput("bash") });
    expect(grep.result.content[0]).toEqual({ type: "text", text: largeOutput("grep") });
  });

  it("leaves read and other tool results unchanged", async () => {
    const content: ToolResultContent = [{ type: "text", text: largeOutput("read") }];
    const read = toolResultContext("read", content);
    const write = toolResultContext("write", content);
    const session = sessionWithAfterToolCall();

    installToolResultCompression(session);

    await expect(session.agent.afterToolCall!(read)).resolves.toBeUndefined();
    await expect(session.agent.afterToolCall!(write)).resolves.toBeUndefined();
    expect(read.result.content).toBe(content);
    expect(write.result.content).toBe(content);
  });

  it("runs the extension first, compresses its content, and preserves its other fields", async () => {
    const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
    const details = { extension: true };
    const extensionPatch: AfterToolCallPatch = {
      content: [{ type: "text", text: largeOutput("extension") }, image],
      details,
      isError: true,
      terminate: true,
    };
    const extensionAfterToolCall = vi.fn(async () => extensionPatch);
    const session = sessionWithAfterToolCall(extensionAfterToolCall);
    const context = toolResultContext("grep", [{ type: "text", text: "original" }]);

    installToolResultCompression(session);
    const patch = await session.agent.afterToolCall!(context);

    expect(extensionAfterToolCall).toHaveBeenCalledWith(context, undefined);
    expect(patch).toEqual({
      ...extensionPatch,
      content: [
        { type: "text", text: expect.stringContaining("[... omitted") },
        image,
      ],
    });
    expect(patch).not.toBe(extensionPatch);
    expect(patch?.details).toBe(details);
    expect(patch?.isError).toBe(true);
    expect(patch?.terminate).toBe(true);
    expect(patch?.content?.[1]).toBe(image);
    expect(extensionPatch.content).toEqual([
      { type: "text", text: largeOutput("extension") },
      image,
    ]);
  });

  it("returns the exact extension patch when content does not change", async () => {
    const extensionPatch: AfterToolCallPatch = {
      content: [{ type: "text", text: "small output" }],
      details: { extension: true },
    };
    const session = sessionWithAfterToolCall(async () => extensionPatch);

    installToolResultCompression(session);

    await expect(session.agent.afterToolCall!(
      toolResultContext("bash", [{ type: "text", text: largeOutput("original") }]),
    )).resolves.toBe(extensionPatch);
  });

  it("propagates extension rejection and forwards its abort signal", async () => {
    const failure = new Error("extension tool result failed");
    const extensionAfterToolCall = vi.fn(async () => {
      throw failure;
    });
    const session = sessionWithAfterToolCall(extensionAfterToolCall);
    const controller = new AbortController();
    const context = toolResultContext("bash", [{ type: "text", text: "small output" }]);

    installToolResultCompression(session);

    await expect(session.agent.afterToolCall!(context, controller.signal)).rejects.toBe(failure);
    expect(extensionAfterToolCall).toHaveBeenCalledWith(context, controller.signal);
  });

  it("falls back to the extension patch when host compression fails", async () => {
    const extensionPatch: AfterToolCallPatch = { details: { extension: true } };
    const context = toolResultContext("bash", []);
    Object.defineProperty(context.result, "content", {
      configurable: true,
      get: () => {
        throw new Error("unreadable content");
      },
    });
    const session = sessionWithAfterToolCall(async () => extensionPatch);

    installToolResultCompression(session);

    await expect(session.agent.afterToolCall!(context)).resolves.toBe(extensionPatch);
  });
});
