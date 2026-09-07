import type { ToolItem } from "../chat/reducer";
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

export function isCommitmentTool(tool: ToolItem): boolean {
  return tool.name === "request_edit_budget";
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
  const failed = tool.status === "error";

  const eyebrow = "BUDGET ESTIMATE";
  let title: string;
  let reason: string;
  let budgetMetric:
    | { value: number; total?: number; label: string }
    | undefined;
  const chips: string[] = failed ? ["执行失败"] : [];

  const fileCount = numberField(args, "fileCount");
  title = fileCount === undefined
    ? "申请编辑额度"
    : `预计修改 ${fileCount} 个文件`;
  reason = stringField(args, "reason");
  const grantedFiles = numberField(facts, "grantedFiles");
  const resultRemainingFiles = editBudgetRemainingFiles(tool);
  const remainingFiles = typeof observedEditBudgetRemainingFiles === "number"
    ? observedEditBudgetRemainingFiles
    : observedEditBudgetRemainingFiles === null
      ? undefined
      : resultRemainingFiles;
  if (grantedFiles !== undefined) {
    const remainingMatchesGrant = observedEditBudgetRemainingFiles === undefined
      || observedEditBudgetRemainingFiles === resultRemainingFiles;
    budgetMetric = remainingFiles === undefined
      ? { value: grantedFiles, label: "FILES TOTAL" }
      : {
          value: remainingFiles,
          ...(remainingMatchesGrant ? { total: grantedFiles } : {}),
          label: "FILES LEFT",
        };
    chips.push(`本轮额度 ${grantedFiles}`);
  } else if (fileCount !== undefined) {
    budgetMetric = { value: fileCount, label: "FILES PLANNED" };
  }
  if (observedEditBudgetRemainingFiles === null) {
    chips.push("本轮剩余未知");
  } else if (observedEditBudgetRemainingFiles !== undefined) {
    chips.push(`本轮剩余 ${observedEditBudgetRemainingFiles}`);
  }

  const toneClass = failed ? " is-error" : "";
  const kindClass = " is-edit-budget";
  return <details className={`commitment-card${kindClass}${toneClass}`}>
    <summary>
      {budgetMetric ? <span
        className="commitment-budget-metric"
        aria-label={`${budgetMetric.value}${
          budgetMetric.total === undefined ? "" : ` / ${budgetMetric.total}`
        } ${budgetMetric.label}`}
      >
        <span>
          <strong>{budgetMetric.value}</strong>
          {budgetMetric.total !== undefined && <span>/{budgetMetric.total}</span>}
        </span>
        <small>{budgetMetric.label}</small>
      </span> : <span className="commitment-node" aria-hidden="true" />}
      <span className="commitment-copy">
        <span className="commitment-eyebrow">{eyebrow}</span>
        <strong>{title}</strong>
        {reason ? <span className="commitment-reason" title={reason}>{reason}</span> : null}
      </span>
      {chips.length > 0 ? <span className="commitment-facts">
        {chips.map((chip) => <span className="commitment-fact" key={chip}>{chip}</span>)}
      </span> : null}
      <span className="commitment-chevron" aria-hidden="true">⌄</span>
    </summary>
    <ToolDetails tool={tool} />
  </details>;
}
