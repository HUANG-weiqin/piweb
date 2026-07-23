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

  it.each([
    "git_status",
    "git_diff",
    "notebook_write",
    "notebook_list",
    "notebook_grep",
    "notebook_read",
  ])(
    "allows the host-owned %s tool in read-only mode",
    (toolName) => {
      expect(defaultToolPolicy({
        mode: "read_only",
        toolName,
        toolSource: "sdk",
      })).toEqual({ action: "allow" });
    },
  );

  it.each([
    ["bash", "builtin"],
    ["write", "builtin"],
    ["edit", "builtin"],
    ["read", "project"],
    ["grep", "extension"],
    ["find", "project"],
    ["ls", "extension"],
    ["custom", "unknown"],
    ["git_status", "builtin"],
    ["git_status", "project"],
    ["git_status", "extension"],
    ["git_status", "unknown"],
    ["git_diff", "builtin"],
    ["git_diff", "project"],
    ["git_diff", "extension"],
    ["git_diff", "unknown"],
    ["notebook_list", "builtin"],
    ["notebook_grep", "extension"],
    ["notebook_read", "project"],
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
