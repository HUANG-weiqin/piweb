import { describe, expect, it } from "vitest";
import { parseClientCommand } from "./protocol.js";

describe("parseClientCommand", () => {
  it("accepts supported commands", () => {
    expect(parseClientCommand({ type: "initialize", cwd: "E:\\work" }).type).toBe("initialize");
    expect(parseClientCommand({ type: "prompt", text: "hello" }).type).toBe("prompt");
    expect(parseClientCommand({ type: "set_api_key", provider: "openai", key: "secret" }).type).toBe("set_api_key");
    expect(parseClientCommand({ type: "auth_response", requestId: "1", value: "code" }).type).toBe("auth_response");
  });

  it("rejects empty prompts and unknown commands", () => {
    expect(() => parseClientCommand({ type: "prompt", text: "  " })).toThrow();
    expect(() => parseClientCommand({ type: "invented" })).toThrow();
  });

  it("rejects oversized socket messages", () => {
    expect(() => parseClientCommand("x".repeat(1_000_001))).toThrow("too large");
  });
});
