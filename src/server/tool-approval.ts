import { randomUUID } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ToolApprovalRequest,
  ToolMode,
} from "../shared/protocol.js";

export interface ToolPolicyContext {
  cwd: string;
  mode: ToolMode;
  toolCallId: string;
  toolName: string;
  toolSource: string;
  args: unknown;
}

export type ToolPolicyDecision =
  | { action: "allow" }
  | { action: "ask"; reason?: string }
  | { action: "deny"; reason: string };

export type ToolPolicy = (
  context: ToolPolicyContext,
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WORKSPACE_WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * Resolve the real location of a possibly not-yet-created path. Existing
 * symlinks (including a broken final/intermediate symlink) are followed so a
 * lexical path below cwd cannot silently target a location outside cwd.
 */
async function resolvePotentialRealPath(
  input: string,
  seen = new Set<string>(),
): Promise<string> {
  const absolute = resolve(input);
  if (seen.has(absolute) || seen.size >= 64) {
    throw new Error("Symbolic link cycle while resolving tool path");
  }
  seen.add(absolute);

  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const canonical = await realpath(current);
      return resolve(canonical, ...suffix);
    } catch (realPathError) {
      let entry;
      try {
        entry = await lstat(current);
      } catch (statError) {
        const code = (statError as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw realPathError;
      }

      if (entry?.isSymbolicLink()) {
        const target = await readlink(current);
        const linked = isAbsolute(target)
          ? target
          : resolve(dirname(current), target);
        const canonical = await resolvePotentialRealPath(linked, seen);
        return resolve(canonical, ...suffix);
      }
      if (entry) throw realPathError;

      // Missing paths are resolved from their nearest existing real parent.
      const parent = dirname(current);
      if (parent === current) throw new Error(`Cannot resolve tool path: ${input}`);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const canonicalRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const canonicalTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const pathFromRoot = relative(canonicalRoot, canonicalTarget);
  return pathFromRoot === ""
    || (!isAbsolute(pathFromRoot)
      && pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`));
}

type WriteTarget = "workspace" | "host_state" | "external";

async function classifyWriteTarget(cwd: string, args: unknown): Promise<WriteTarget> {
  if (!args || typeof args !== "object") return "external";
  const path = (args as Record<string, unknown>).path;
  if (typeof path !== "string" || !path) return "external";
  const lexicalWorkspace = resolve(cwd);
  const lexicalTarget = resolve(cwd, path);
  if (!isWithin(lexicalWorkspace, lexicalTarget)) return "external";
  const lexicalStateDir = resolve(lexicalWorkspace, ".piweb");
  if (isWithin(lexicalStateDir, lexicalTarget)) return "host_state";

  const [workspace, target, stateDir] = await Promise.all([
    realpath(cwd),
    resolvePotentialRealPath(lexicalTarget),
    resolvePotentialRealPath(lexicalStateDir),
  ]);
  if (isWithin(stateDir, target)) return "host_state";
  return isWithin(workspace, target) ? "workspace" : "external";
}

/**
 * Read-only mode is a hard deny for every capability that is not known to be
 * read-only. Workspace-write mode auto-allows edit/write only when their real
 * target remains inside cwd; commands and extension tools still require review.
 */
export const defaultToolPolicy: ToolPolicy = async ({
  cwd,
  mode,
  toolName,
  toolSource,
  args,
}) => {
  const builtIn = toolSource === "builtin";
  if (builtIn && READ_ONLY_TOOLS.has(toolName)) return { action: "allow" };
  if (mode === "read_only") {
    return { action: "deny", reason: "只读模式禁止写入、执行命令和未知扩展工具。" };
  }
  if (builtIn && WORKSPACE_WRITE_TOOLS.has(toolName)) {
    try {
      const target = await classifyWriteTarget(cwd, args);
      if (target === "workspace") return { action: "allow" };
      if (target === "host_state") {
        return {
          action: "deny",
          reason: ".piweb 是工作台管理的项目状态，不能由 Agent 工具直接修改。",
        };
      }
    } catch {
      // If path ownership cannot be proven, fail closed by asking.
    }
    return { action: "ask", reason: "此工具的写入目标位于工作区外或无法安全确认。" };
  }
  if (toolName === "bash") {
    return { action: "ask", reason: "此工具将执行本地命令。" };
  }
  return { action: "ask", reason: "扩展工具可能修改本机或访问外部资源。" };
};

interface PendingApproval {
  sessionId: string;
  runId: string;
  approvalId: string;
  signal?: AbortSignal;
  onAbort?: () => void;
  request: ToolApprovalRequest;
  resolve: (decision: "allow" | "deny") => void;
}

export interface ApprovalRequestContext {
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  reason?: string;
  signal?: AbortSignal;
}

/**
 * Connection-scoped rendezvous between an SDK tool hook and browser responses.
 * Identity matching is exact; unknown, duplicate, and stale responses are no-ops.
 */
export class ToolApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly usedApprovalIds = new Set<string>();

  constructor(
    private readonly onChange: () => void,
    private readonly createApprovalId: () => string = randomUUID,
  ) {}

  request(context: ApprovalRequestContext): Promise<"allow" | "deny"> {
    if (context.signal?.aborted) return Promise.resolve("deny");

    const approvalId = this.nextApprovalId();
    return new Promise<"allow" | "deny">((resolve, reject) => {
      const pending: PendingApproval = {
        sessionId: context.sessionId,
        runId: context.runId,
        approvalId,
        signal: context.signal,
        request: {
          approvalId,
          toolCallId: context.toolCallId,
          toolName: context.toolName,
          args: context.args,
          reason: context.reason,
        },
        resolve,
      };
      if (context.signal) {
        pending.onAbort = () => this.settle(pending, "deny");
        context.signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(approvalId, pending);
      try {
        this.onChange();
      } catch (error) {
        this.remove(pending);
        reject(error);
      }
    });
  }

  respond(input: {
    sessionId: string;
    runId: string;
    approvalId: string;
    decision: "allow" | "deny";
  }): boolean {
    const pending = this.pending.get(input.approvalId);
    if (
      !pending
      || pending.sessionId !== input.sessionId
      || pending.runId !== input.runId
    ) {
      return false;
    }
    this.settle(pending, input.decision);
    return true;
  }

  cancelRun(sessionId: string, runId: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.sessionId === sessionId && pending.runId === runId) {
        this.settle(pending, "deny");
      }
    }
  }

  cancelAll(): void {
    for (const pending of [...this.pending.values()]) {
      this.settle(pending, "deny");
    }
  }

  requestsFor(sessionId: string, runId: string): ToolApprovalRequest[] {
    return [...this.pending.values()]
      .filter((pending) => (
        pending.sessionId === sessionId && pending.runId === runId
      ))
      .map((pending) => structuredClone(pending.request));
  }

  private settle(pending: PendingApproval, decision: "allow" | "deny"): void {
    if (this.pending.get(pending.approvalId) !== pending) return;
    this.remove(pending);
    try {
      this.onChange();
      pending.resolve(decision);
    } catch {
      pending.resolve("deny");
    }
  }

  private nextApprovalId(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const approvalId = this.createApprovalId();
      if (this.usedApprovalIds.has(approvalId)) continue;
      this.usedApprovalIds.add(approvalId);
      return approvalId;
    }
    throw new Error("Could not allocate a unique tool approval ID");
  }

  private remove(pending: PendingApproval): void {
    this.pending.delete(pending.approvalId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }
}
