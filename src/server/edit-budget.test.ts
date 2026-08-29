import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalMutationPathKey,
  createEditBudgetLedger,
  snapshotEditBudget,
} from "./edit-budget.js";

describe("edit budget accounting", () => {
  it("reports grants, distinct touches, and remaining files", () => {
    const ledger = createEditBudgetLedger();
    ledger.grantedFiles = 2;
    ledger.touchedPathKeys.add("one");
    ledger.touchedPathKeys.add("one");
    ledger.blockedAttempts = 1;

    expect(snapshotEditBudget(ledger)).toEqual({
      grantedFiles: 2,
      touchedFiles: 1,
      remainingFiles: 1,
      blockedAttempts: 1,
    });
  });

  it("uses Pi-style path normalization and folds aliases of an existing file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-edit-budget-"));
    try {
      await writeFile(join(cwd, "target file.ts"), "export {};\n", "utf8");
      await writeFile(join(cwd, " target file.ts"), "export {};\n", "utf8");

      const direct = await canonicalMutationPathKey(cwd, {
        path: "target file.ts",
      });
      const normalized = await canonicalMutationPathKey(cwd, {
        path: "@./nested/../target\u00A0file.ts",
      });
      const leadingSpace = await canonicalMutationPathKey(cwd, {
        path: " target file.ts",
      });

      expect(direct).toBeDefined();
      expect(normalized).toBe(direct);
      expect(leadingSpace).not.toBe(direct);
      await expect(canonicalMutationPathKey(cwd, {})).resolves.toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
