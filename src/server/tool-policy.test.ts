import { describe, expect, it } from "vitest";
import { defaultToolPolicy } from "./tool-policy.js";

describe("defaultToolPolicy", () => {
  it.each(["read", "grep", "find", "ls"])(
    "allows Pi's built-in %s tool in read-only mode",
    (toolName) => {
      expect(defaultToolPolicy({
        mode: "read_only",
        toolName,
        toolSource: "builtin",
      })).toEqual({ action: "allow" });
    },
  );

  it("allows only the host-owned Git inspector in read-only mode", () => {
    expect(defaultToolPolicy({
      mode: "read_only",
      toolName: "git_inspect",
      toolSource: "sdk",
    })).toEqual({ action: "allow" });
  });

  it.each([
    ["bash", "builtin"],
    ["write", "builtin"],
    ["edit", "builtin"],
    ["read", "project"],
    ["grep", "extension"],
    ["find", "project"],
    ["ls", "extension"],
    ["custom", "unknown"],
    ["git_inspect", "builtin"],
    ["git_inspect", "project"],
    ["git_inspect", "extension"],
    ["git_inspect", "unknown"],
  ])(
    "denies %s from %s in read-only mode",
    (toolName, toolSource) => {
      expect(defaultToolPolicy({
        mode: "read_only",
        toolName,
        toolSource,
      })).toMatchObject({ action: "deny" });
    },
  );

  it.each([
    ["bash", "builtin"],
    ["write", "builtin"],
    ["custom", "project"],
    ["unknown", "unknown"],
  ])(
    "allows %s from %s in full-access mode",
    (toolName, toolSource) => {
      expect(defaultToolPolicy({
        mode: "full_access",
        toolName,
        toolSource,
      })).toEqual({ action: "allow" });
    },
  );
});
