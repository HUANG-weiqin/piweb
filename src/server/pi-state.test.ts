import { describe, expect, it } from "vitest";
import { buildPublicProviders } from "./pi-state.js";

describe("buildPublicProviders", () => {
  it("groups models and exposes status without credential values", () => {
    const providers = buildPublicProviders({
      registeredProviderIds: [],
      models: [{
        provider: "openai",
        id: "gpt",
        name: "GPT",
        reasoning: true,
        thinkingLevelMap: { max: null },
        api: "openai-codex-responses",
        input: ["text"],
        contextWindow: 100,
      }],
      availableKeys: new Set(["openai/gpt"]),
      oauthProviders: new Map([["openai-codex", "OpenAI Codex"]]),
      displayName: () => "OpenAI",
      authStatus: () => ({ configured: true, source: "stored", label: "API key" }),
    });
    expect(providers.find((provider) => provider.id === "openai")?.models[0].available).toBe(true);
    expect(providers.find((provider) => provider.id === "openai")?.models[0].thinkingLevels)
      .toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(providers.find((provider) => provider.id === "openai")?.models[0].serviceTiers)
      .toEqual(["priority"]);
    expect(providers.find((provider) => provider.id === "openai-codex")?.oauth).toBe(true);
    expect(JSON.stringify(providers)).not.toContain("secret");
  });

  it("projects registered providers even when their model list is empty", () => {
    const providers = buildPublicProviders({
      registeredProviderIds: ["static-empty"],
      models: [],
      availableKeys: new Set(),
      oauthProviders: new Map(),
      displayName: (provider) => provider,
      authStatus: () => ({ configured: false }),
    });

    expect(providers).toEqual([expect.objectContaining({
      id: "static-empty",
      models: [],
      oauth: false,
    })]);
    expect(providers.some((provider) => provider.id === "not-registered")).toBe(false);
  });

  it("matches Pi thinking-level support for sparse model maps", () => {
    const providers = buildPublicProviders({
      registeredProviderIds: [],
      models: [{
        provider: "opencode",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          max: "max",
        },
      }],
      availableKeys: new Set(["opencode/deepseek-v4-pro"]),
      oauthProviders: new Map(),
      displayName: () => "OpenCode",
      authStatus: () => ({ configured: true }),
    });

    expect(providers[0]?.models[0]?.thinkingLevels)
      .toEqual(["off", "high", "max"]);
  });
});
