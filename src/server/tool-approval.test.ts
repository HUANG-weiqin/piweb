import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultToolPolicy, ToolApprovalBroker } from "./tool-approval.js";

const SESSION = "0dd23f7c-80c8-4713-b7a7-33c00177a101";
const OTHER_SESSION = "e15c861c-e18f-4290-bc22-8932f3caaf4e";
const RUN = "ba39f161-b67f-47c9-9285-e391427ed7d0";
const OTHER_RUN = "65feacc3-00b4-45bd-80ee-5e18bc32f7dc";
const APPROVAL_A = "8f310256-f2ab-481d-8ca2-f20a43392ba3";
const APPROVAL_B = "640b374c-6fd4-4287-b5a4-cc56656efda6";

function approvalRequest(broker: ToolApprovalBroker) {
  const request = broker.requestsFor(SESSION, RUN).at(-1);
  if (!request) throw new Error("approval request not created");
  return request;
}

describe("defaultToolPolicy", () => {
  it("hard-blocks mutation in read-only mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-policy-readonly-"));
    const input = {
      cwd,
      mode: "read_only" as const,
      toolCallId: "tool-1",
      toolSource: "builtin",
    };

    expect(await defaultToolPolicy({ ...input, toolName: "read", args: { path: "a.ts" } })).toEqual({
      action: "allow",
    });
    expect(await defaultToolPolicy({ ...input, toolName: "write", args: { path: "a.ts" } })).toMatchObject({
      action: "deny",
    });
    expect(await defaultToolPolicy({ ...input, toolName: "bash", args: {} })).toMatchObject({
      action: "deny",
    });
  });

  it("allows workspace writes but asks for outside, command, and extension tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-policy-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "piweb-policy-outside-"));
    const input = {
      cwd,
      mode: "workspace_write" as const,
      toolCallId: "tool-1",
      toolSource: "builtin",
    };

    expect(await defaultToolPolicy({
      ...input,
      toolName: "write",
      args: { path: "new/deep/file.ts" },
    })).toEqual({ action: "allow" });
    expect(await defaultToolPolicy({
      ...input,
      toolName: "edit",
      args: { path: join(outside, "outside.ts") },
    })).toMatchObject({ action: "ask" });
    expect(await defaultToolPolicy({ ...input, toolName: "bash", args: {} })).toMatchObject({
      action: "ask",
    });
    expect(await defaultToolPolicy({
      ...input,
      toolName: "custom",
      toolSource: "project",
      args: {},
    })).toMatchObject({
      action: "ask",
    });
  });

  it("does not auto-allow an extension tool that shadows a built-in name", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-policy-shadow-"));

    expect(await defaultToolPolicy({
      cwd,
      mode: "workspace_write",
      toolCallId: "tool-1",
      toolName: "write",
      toolSource: "project",
      args: { path: "inside.ts" },
    })).toMatchObject({ action: "ask" });
    expect(await defaultToolPolicy({
      cwd,
      mode: "read_only",
      toolCallId: "tool-2",
      toolName: "read",
      toolSource: "project",
      args: { path: "inside.ts" },
    })).toMatchObject({ action: "deny" });
  });

  it("reserves project-local workbench state from agent writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-policy-state-"));
    await mkdir(join(cwd, ".piweb", "sessions"), { recursive: true });

    expect(await defaultToolPolicy({
      cwd,
      mode: "workspace_write",
      toolCallId: "tool-1",
      toolName: "write",
      toolSource: "builtin",
      args: { path: ".piweb/project.json" },
    })).toMatchObject({
      action: "deny",
      reason: expect.stringContaining(".piweb"),
    });
  });

  it("reserves workbench state reached through an in-project symlink", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-policy-state-link-"));
    const stateDir = join(cwd, ".piweb");
    await mkdir(stateDir);
    await symlink(
      stateDir,
      join(cwd, "state-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(await defaultToolPolicy({
      cwd,
      mode: "workspace_write",
      toolCallId: "tool-1",
      toolName: "edit",
      toolSource: "builtin",
      args: { path: "state-alias/project.json" },
    })).toMatchObject({ action: "deny" });
  });

  it("does not treat an in-workspace symlink to an outside directory as workspace-owned", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-policy-symlink-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "piweb-policy-symlink-outside-"));
    const link = join(cwd, "linked");
    await mkdir(join(outside, "target"));
    await symlink(
      join(outside, "target"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(await defaultToolPolicy({
      cwd,
      mode: "workspace_write",
      toolCallId: "tool-1",
      toolName: "write",
      toolSource: "builtin",
      args: { path: "linked/new.ts" },
    })).toMatchObject({ action: "ask" });
  });
});

describe("ToolApprovalBroker", () => {
  it("settles only an exactly matching response and ignores duplicates", async () => {
    let changes = 0;
    const broker = new ToolApprovalBroker(() => {
      changes++;
    });
    const decision = broker.request({
      sessionId: SESSION,
      runId: RUN,
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    const request = approvalRequest(broker);

    expect(broker.respond({
      sessionId: OTHER_SESSION,
      runId: RUN,
      approvalId: request.approvalId,
      decision: "allow",
    })).toBe(false);
    expect(broker.respond({
      sessionId: SESSION,
      runId: OTHER_RUN,
      approvalId: request.approvalId,
      decision: "allow",
    })).toBe(false);
    expect(broker.respond({
      sessionId: SESSION,
      runId: RUN,
      approvalId: request.approvalId,
      decision: "allow",
    })).toBe(true);
    expect(await decision).toBe("allow");
    expect(broker.respond({
      sessionId: SESSION,
      runId: RUN,
      approvalId: request.approvalId,
      decision: "deny",
    })).toBe(false);
    expect(changes).toBe(2);
  });

  it("denies every pending request when its run is cancelled", async () => {
    const broker = new ToolApprovalBroker(() => undefined);
    const first = broker.request({
      sessionId: SESSION,
      runId: RUN,
      toolCallId: "tool-1",
      toolName: "bash",
    });
    const second = broker.request({
      sessionId: SESSION,
      runId: RUN,
      toolCallId: "tool-2",
      toolName: "write",
    });

    broker.cancelRun(SESSION, RUN);

    await expect(Promise.all([first, second])).resolves.toEqual(["deny", "deny"]);
  });

  it("fails closed when the SDK abort signal fires", async () => {
    const broker = new ToolApprovalBroker(() => undefined);
    const controller = new AbortController();
    const decision = broker.request({
      sessionId: SESSION,
      runId: RUN,
      toolCallId: "tool-1",
      toolName: "bash",
      signal: controller.signal,
    });
    const request = approvalRequest(broker);

    controller.abort();

    await expect(decision).resolves.toBe("deny");
    expect(broker.respond({
      sessionId: SESSION,
      runId: RUN,
      approvalId: request.approvalId,
      decision: "allow",
    })).toBe(false);
  });

  it("never reuses an approval id after settlement", async () => {
    const generated = [APPROVAL_A, APPROVAL_A, APPROVAL_B];
    const broker = new ToolApprovalBroker(
      () => undefined,
      () => generated.shift() ?? APPROVAL_B,
    );
    const first = broker.request({
      sessionId: SESSION,
      runId: RUN,
      toolCallId: "tool-1",
      toolName: "bash",
    });
    expect(approvalRequest(broker).approvalId).toBe(APPROVAL_A);
    expect(broker.respond({
      sessionId: SESSION,
      runId: RUN,
      approvalId: APPROVAL_A,
      decision: "deny",
    })).toBe(true);
    await first;

    const second = broker.request({
      sessionId: SESSION,
      runId: RUN,
      toolCallId: "tool-2",
      toolName: "bash",
    });
    expect(approvalRequest(broker).approvalId).toBe(APPROVAL_B);
    expect(broker.respond({
      sessionId: SESSION,
      runId: RUN,
      approvalId: APPROVAL_A,
      decision: "allow",
    })).toBe(false);
    broker.cancelAll();
    await second;
  });
});
