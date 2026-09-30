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
    "bash",
    "bash_poll",
    "bash_stop",
    "notebook_write",
    "notebook_list",
    "notebook_grep",
    "notebook_read",
    "list_roles",
    "read_role",
    "propose_role_revision",
    "current_time",
    "lsp_symbols",
    "lsp_definition",
    "lsp_references",
    "todo_read",
    "todo_write",
    "todo_pause",
    "request_context_compaction",
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
    ["bash", "project"],
    ["bash", "extension"],
    ["bash", "unknown"],
    ["bash_poll", "builtin"],
    ["bash_poll", "project"],
    ["bash_poll", "extension"],
    ["bash_stop", "builtin"],
    ["bash_stop", "project"],
    ["bash_stop", "extension"],
    ["write", "builtin"],
    ["edit", "builtin"],
    ["read", "project"],
    ["grep", "extension"],
    ["find", "project"],
    ["ls", "extension"],
    ["custom", "unknown"],
    ["notebook_list", "builtin"],
    ["notebook_grep", "extension"],
    ["notebook_read", "project"],
    ["current_time", "builtin"],
    ["current_time", "extension"],
    ["lsp_symbols", "builtin"],
    ["lsp_definition", "project"],
    ["lsp_references", "extension"],
    ["todo_read", "builtin"],
    ["todo_write", "project"],
    ["todo_pause", "extension"],
    ["request_context_compaction", "extension"],
    ["list_sessions", "sdk"],
    ["current_session", "sdk"],
    ["start_session", "sdk"],
    ["computer", "sdk"],
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
