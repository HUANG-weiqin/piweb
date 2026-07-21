import { describe, expect, it } from "vitest";
import { buildPublicProviders } from "./pi-state.js";

describe("buildPublicProviders", () => {
  it("groups models and exposes status without credential values", () => {
    const providers = buildPublicProviders({
      models: [{
        provider: "openai",
        id: "gpt",
        name: "GPT",
        reasoning: true,
        thinkingLevelMap: { max: null },
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
      .toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(providers.find((provider) => provider.id === "openai-codex")?.oauth).toBe(true);
    expect(JSON.stringify(providers)).not.toContain("secret");
  });
});
