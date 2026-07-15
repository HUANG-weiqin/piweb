import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "./socket-server.js";

describe("isAllowedOrigin", () => {
  it("allows local browser origins", () => {
    expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isAllowedOrigin("http://localhost:31415")).toBe(true);
  });

  it("rejects remote and malformed origins", () => {
    expect(isAllowedOrigin("https://example.com")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });
});
