import { describe, expect, it } from "vitest";
import { validateEditBudgetEvents } from "./edit-budget.js";

describe("legacy edit-budget journal validation", () => {
  it("accepts valid historical grants and irreversible charges", () => {
    const runId = "f74fedb8-ea07-49a6-bd47-3036f7b06a27";
    const events = [
      { kind: "grant" as const, runId, fileCount: 1 },
      { kind: "charge" as const, runId, pathKey: "/project/one.ts" },
      { kind: "grant" as const, runId, fileCount: 2 },
      { kind: "charge" as const, runId, pathKey: "/project/two.ts" },
      { kind: "charge" as const, runId, pathKey: "/project/one.ts" },
    ];

    expect(() => validateEditBudgetEvents(events)).not.toThrow();
  });

  it("rejects a historical charge without an available grant", () => {
    const runId = "f74fedb8-ea07-49a6-bd47-3036f7b06a27";

    expect(() => validateEditBudgetEvents([
      { kind: "charge", runId, pathKey: "/project/ungranted.ts" },
    ])).toThrow(/exceeds the granted file count/i);
  });
});
