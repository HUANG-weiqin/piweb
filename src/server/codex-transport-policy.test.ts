import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyCodexAutoTransportPolicy } from "./codex-transport-policy.js";

function errorMessage(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

describe("applyCodexAutoTransportPolicy", () => {
  it("uses SSE only for the Codex Responses API when transport is auto", () => {
    const settings = SettingsManager.inMemory({ transport: "auto" });

    applyCodexAutoTransportPolicy(settings, {
      provider: "openai-codex",
      api: "openai-codex-responses",
    });

    expect(settings.getTransport()).toBe("sse");
  });

  it("leaves non-Codex providers unchanged", () => {
    const settings = SettingsManager.inMemory({ transport: "auto" });

    applyCodexAutoTransportPolicy(settings, {
      provider: "openai",
      api: "openai-responses",
    });

    expect(settings.getTransport()).toBe("auto");
  });

  it.each(["sse", "websocket", "websocket-cached"] as const)(
    "preserves explicit %s transport",
    (transport) => {
      const settings = SettingsManager.inMemory({ transport });

      applyCodexAutoTransportPolicy(settings, {
        provider: "openai-codex",
        api: "openai-codex-responses",
      });

      expect(settings.getTransport()).toBe(transport);
    },
  );

  it("does not persist its disk-backed override", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-codex-policy-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "piweb-codex-policy-agent-"));
    const settingsPath = join(agentDir, "settings.json");
    await writeFile(settingsPath, '{"transport":"auto"}\n', "utf8");
    const settings = SettingsManager.create(cwd, agentDir);

    applyCodexAutoTransportPolicy(settings, {
      provider: "openai-codex",
      api: "openai-codex-responses",
    });
    await settings.flush();

    expect(await readFile(settingsPath, "utf8")).toBe('{"transport":"auto"}\n');
    expect(SettingsManager.create(cwd, agentDir).getTransport()).toBe("auto");
  });
});

describe("Pi context overflow classification", () => {
  it.each([
    "WebSocket error",
    "exceeded request buffer limit while retrying upstream",
  ])("does not classify transport error %j as context overflow", (message) => {
    expect(isContextOverflow(errorMessage(message))).toBe(false);
  });

  it("continues to classify context_length_exceeded as context overflow", () => {
    expect(isContextOverflow(errorMessage("context_length_exceeded"))).toBe(true);
  });
});
