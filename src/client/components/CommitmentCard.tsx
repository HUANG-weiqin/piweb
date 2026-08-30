import type { ToolItem } from "../chat/reducer";
import { ActivitySpinner } from "./ActivitySpinner";
import { ToolDetails } from "./ToolCard";

type ToolRecord = Record<string, unknown>;

function asRecord(value: unknown): ToolRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ToolRecord
    : undefined;
}

function stringField(record: ToolRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberField(record: ToolRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function resultFacts(tool: ToolItem): ToolRecord | undefined {
  const result = asRecord(tool.result);
  return asRecord(result?.details) ?? result;
}

export function editBudgetRemainingFiles(tool: ToolItem): number | undefined {
  const facts = resultFacts(tool);
  if (tool.name === "request_edit_budget") {
    return numberField(facts, "remainingFiles");
  }
  if (tool.name !== "edit" && tool.name !== "write") return undefined;
  return numberField(asRecord(facts?.piwebEditBudget), "remainingFiles");
}

function waitWasNotStarted(tool: ToolItem): boolean {
  return tool.name === "wait_for_session"
    && resultFacts(tool)?.outcome === "single_wait_commitment_required";
}

export function isCommitmentTool(tool: ToolItem): boolean {
  if (tool.name === "request_edit_budget") return true;
  if (tool.name !== "wait_for_session") return false;
  const args = asRecord(tool.args);
  const exactWait = args !== undefined
    && !("targets" in args)
    && !!stringField(args, "conversationId")
    && !!stringField(args, "runId");
  return exactWait && (
    waitWasNotStarted(tool)
    || !!stringField(args, "singleWaitCommitment")
  );
}

export function CommitmentCard({
  tool,
  observedEditBudgetRemainingFiles,
}: {
  tool: ToolItem;
  observedEditBudgetRemainingFiles?: number | null;
}) {
  const args = asRecord(tool.args);
  const facts = resultFacts(tool);
  const warning = waitWasNotStarted(tool);
  const failed = !warning && tool.status === "error";
  const editBudget = tool.name === "request_edit_budget";
  const activeWait = !warning
    && !editBudget
    && (tool.status === "pending" || tool.status === "running");

  let eyebrow = editBudget ? "编辑承诺" : "单会话等待承诺";
  let title: string;
  let reason: string;
  const chips: string[] = failed ? ["执行失败"] : [];

  if (warning) {
    eyebrow = "等待未开始";
    title = "需要先说明单独等待的理由";
    reason = "可以继续本地工作、改为多目标等待，或带承诺再次调用。";
  } else if (editBudget) {
    const fileCount = numberField(args, "fileCount");
    title = fileCount === undefined
      ? "申请编辑额度"
      : `预计修改 ${fileCount} 个文件`;
    reason = stringField(args, "reason");
    const addedFiles = numberField(facts, "addedFiles");
    if (addedFiles !== undefined) chips.push(`新增额度 ${addedFiles}`);
    if (observedEditBudgetRemainingFiles === null) {
      chips.push("本轮剩余未知");
    } else if (observedEditBudgetRemainingFiles !== undefined) {
      chips.push(`本轮剩余 ${observedEditBudgetRemainingFiles}`);
    }
  } else {
    const target = stringField(args, "conversationId");
    title = target ? `等待 ${target}` : "等待 Agent 会话";
    reason = stringField(args, "singleWaitCommitment");
  }

  const toneClass = warning ? " is-warning" : failed ? " is-error" : "";
  return <details className={`commitment-card${toneClass}`}>
    <summary>
      <span className="commitment-node" aria-hidden="true" />
      <span className="commitment-copy">
        <span className="commitment-eyebrow">{eyebrow}</span>
        <strong>{title}</strong>
        {reason ? <span className="commitment-reason" title={reason}>{reason}</span> : null}
      </span>
      {activeWait || chips.length > 0 ? <span className="commitment-facts">
        {activeWait ? <span className="commitment-fact">
          <ActivitySpinner className="commitment-spinner" />
          等待中
        </span> : null}
        {chips.map((chip) => <span className="commitment-fact" key={chip}>{chip}</span>)}
      </span> : null}
      <span className="commitment-chevron" aria-hidden="true">⌄</span>
    </summary>
    <ToolDetails tool={tool} />
  </details>;
}
