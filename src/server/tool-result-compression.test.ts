import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { compressToolResultText, installToolResultCompression } from "./tool-result-compression.js";

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
  it("folds consecutive grep match and context lines by path", () => {
    const path = `workspace/${"nested/".repeat(10)}file.ts`;
    const match = "match ".repeat(20);
    const context = "context ".repeat(20);
    const input = `${path}:123: ${match}\n${path}-122- ${context}`;

    expect(compressToolResultText("grep", input)).toBe(
      `[file: ${path}]\n123: ${match}\n122- ${context}`,
    );
  });

  it("folds each multi-file grep group and leaves single-line groups unchanged", () => {
    const firstPath = `workspace/${"first/".repeat(10)}file.ts`;
    const secondPath = `workspace/${"second/".repeat(10)}file.ts`;
    const text = "match ".repeat(20);
    const input = [
      `${firstPath}:1: ${text}`,
      `${firstPath}:2: ${text}`,
      `${secondPath}:3: ${text}`,
      `${secondPath}:4: ${text}`,
    ].join("\n");

    expect(compressToolResultText("grep", input)).toBe([
      `[file: ${firstPath}]`,
      `1: ${text}`,
      `2: ${text}`,
      `[file: ${secondPath}]`,
      `3: ${text}`,
      `4: ${text}`,
    ].join("\n"));
    expect(compressToolResultText("grep", `${firstPath}:1: ${text}`)).toBe(
      `${firstPath}:1: ${text}`,
    );
  });

  it("handles CRLF, Unicode, and source-like delimiters after the grep location", () => {
    const path = `workspace/${"nested/".repeat(10)}file.ts`;
    const suffix = `${"结果".repeat(30)} value:900: tail-901- more`;
    const input = `${path}:1: first ${suffix}\r\n${path}-2- second ${suffix}`;

    expect(compressToolResultText("grep", input)).toBe(
      `[file: ${path}]\n1: first ${suffix}\n2- second ${suffix}`,
    );
  });

  it("references nonconsecutive long duplicate lines at their first output line", () => {
    const repeated = `same ${"x".repeat(80)}`;
    const input = `${repeated}\nbridge ${"y".repeat(80)}\n${repeated}`;

    expect(compressToolResultText("bash", input)).toBe(
      `${repeated}\nbridge ${"y".repeat(80)}\n[duplicate of output line 1]`,
    );
  });

  it("counts grep path headers when referencing a duplicate body", () => {
    const firstPath = `workspace/${"first/".repeat(10)}file.ts`;
    const secondPath = `workspace/${"second/".repeat(10)}file.ts`;
    const repeated = `same ${"x".repeat(80)}`;
    const input = [
      `${firstPath}:1: ${repeated}`,
      `${firstPath}:2: ${"a".repeat(80)}`,
      `${secondPath}:1: ${repeated}`,
      `${secondPath}:2: ${"b".repeat(80)}`,
    ].join("\n");

    expect(compressToolResultText("grep", input)).toBe([
      `[file: ${firstPath}]`,
      `1: ${repeated}`,
      `2: ${"a".repeat(80)}`,
      `[file: ${secondPath}]`,
      "[duplicate of output line 2]",
      `2: ${"b".repeat(80)}`,
    ].join("\n"));
  });

  it("does not reference short duplicate lines", () => {
    const repeated = "x".repeat(63);
    const input = `${repeated}\nbridge\n${repeated}`;

    expect(compressToolResultText("bash", input)).toBe(input);
  });

  it("returns the exact original when post-processing misses the final benefit guard", () => {
    const input = "a:1: match\na:2: context";

    expect(compressToolResultText("grep", input)).toBe(input);
  });

  it("is idempotent", () => {
    const path = `workspace/${"nested/".repeat(10)}file.ts`;
    const input = `${path}:1: ${"match ".repeat(20)}\n${path}:2: ${"context ".repeat(20)}`;
    const output = compressToolResultText("grep", input);

    expect(compressToolResultText("grep", output)).toBe(output);
  });

  it("adds grep headers after generic sampling, never leaving shortened child lines without one", () => {
    const path = `workspace/${"nested/".repeat(10)}very-long-file-name.ts`;
    const input = Array.from(
      { length: 300 },
      (_, index) => `${path}:${index + 1}: ${"x".repeat(100)}`,
    ).join("\n");
    const output = compressToolResultText("grep", input);
    let hasHeader = false;
    let shortenedChildren = 0;

    for (const line of output.split("\n")) {
      if (line.startsWith("[file: ")) {
        hasHeader = true;
      } else if (line.startsWith("[... omitted ")) {
        hasHeader = false;
      } else if (/^\d+[:\-] /.test(line)) {
        expect(hasHeader).toBe(true);
        shortenedChildren += 1;
      } else {
        hasHeader = false;
      }
    }

    expect(output).toContain("[... omitted");
    expect(shortenedChildren).toBeGreaterThan(0);
  });

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
