export const EDIT_BUDGET_CUSTOM_TYPE = "piweb.edit_budget.v1";
export const MAX_EDIT_BUDGET_FILES_PER_REQUEST = 100;
export const MAX_EDIT_BUDGET_PATH_KEY_BYTES = 32 * 1024;

/**
 * Parser-only compatibility for budget records written before the one-time
 * first-write gate replaced edit budgets. New code must not append these.
 */
export type EditBudgetEvent =
  | {
    kind: "grant";
    runId: string;
    fileCount: number;
  }
  | {
    kind: "charge";
    runId: string;
    pathKey: string;
  };

/**
 * Preserves the old per-run journal invariant while opening historic JSONL.
 * A charge was recorded before its builtin call ran, so it can also prove that
 * a recovered legacy run has already passed its first-write admission.
 */
export function validateEditBudgetEvents(
  events: readonly EditBudgetEvent[],
): void {
  const ledgers = new Map<string, {
    grantedFiles: number;
    chargedPathKeys: Set<string>;
  }>();
  for (const event of events) {
    let ledger = ledgers.get(event.runId);
    if (ledger === undefined) {
      ledger = { grantedFiles: 0, chargedPathKeys: new Set() };
      ledgers.set(event.runId, ledger);
    }
    if (event.kind === "grant") {
      ledger.grantedFiles = event.fileCount;
      continue;
    }
    if (
      !ledger.chargedPathKeys.has(event.pathKey)
      && ledger.chargedPathKeys.size >= ledger.grantedFiles
    ) {
      throw new Error(
        `Edit budget charge exceeds the granted file count for run ${event.runId}`,
      );
    }
    ledger.chargedPathKeys.add(event.pathKey);
  }
}
