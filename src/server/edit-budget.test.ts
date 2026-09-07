import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalMutationPathKey,
  createEditBudgetLedger,
  restoreEditBudgetLedger,
  snapshotEditBudget,
  validateEditBudgetEvents,
} from "./edit-budget.js";

describe("edit budget accounting", () => {
  it("reports grants, distinct touches, and remaining files", () => {
    const ledger = createEditBudgetLedger();
    ledger.grantedFiles = 2;
    ledger.chargedPathKeys.add("one");
    ledger.touchedPathKeys.add("one");
    ledger.touchedPathKeys.add("one");
    ledger.blockedAttempts = 1;

    expect(snapshotEditBudget(ledger)).toEqual({
      grantedFiles: 2,
      chargedFiles: 1,
      touchedFiles: 1,
      remainingFiles: 1,
      blockedAttempts: 1,
    });
  });

  it("replays irreversible exact-run charges and rejects an ungranted charge", () => {
    const runId = "f74fedb8-ea07-49a6-bd47-3036f7b06a27";
    const otherRunId = "0dd23f7c-80c8-4713-b7a7-33c00177a101";
    const events = [
      { kind: "grant" as const, runId, fileCount: 1 },
      { kind: "charge" as const, runId, pathKey: "/project/one.ts" },
      { kind: "grant" as const, runId, fileCount: 2 },
      { kind: "charge" as const, runId, pathKey: "/project/two.ts" },
      { kind: "charge" as const, runId, pathKey: "/project/one.ts" },
      { kind: "grant" as const, runId: otherRunId, fileCount: 99 },
    ];

    validateEditBudgetEvents(events);
    expect(snapshotEditBudget(restoreEditBudgetLedger(events, runId))).toEqual({
      grantedFiles: 2,
      chargedFiles: 2,
      touchedFiles: 0,
      remainingFiles: 0,
      blockedAttempts: 0,
    });
    const ungrantedEvents = [
      { kind: "charge" as const, runId, pathKey: "/project/ungranted.ts" },
    ];
    expect(() => restoreEditBudgetLedger(ungrantedEvents, runId))
      .toThrow(/exceeds the granted file count/i);
    expect(() => validateEditBudgetEvents(ungrantedEvents))
      .toThrow(/exceeds the granted file count/i);
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

  it("keeps a missing directory-symlink target stable after creation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-edit-budget-"));
    const target = join(cwd, "target");
    const link = join(cwd, "link");
    try {
      await mkdir(target);
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");

      const before = await canonicalMutationPathKey(cwd, { path: "link/new.ts" });
      await writeFile(join(link, "new.ts"), "export {};\n", "utf8");
      const after = await canonicalMutationPathKey(cwd, { path: "link/new.ts" });
      const direct = await canonicalMutationPathKey(cwd, { path: "target/new.ts" });

      expect(before).toBeDefined();
      expect(after).toBe(before);
      expect(direct).toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a chained dangling final symlink target stable after creation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-edit-budget-"));
    const targetDirectory = join(cwd, "target");
    const target = join(targetDirectory, "new.ts");
    const middle = join(cwd, "middle.ts");
    const link = join(cwd, "link.ts");
    try {
      await mkdir(targetDirectory);
      try {
        await symlink(target, middle, "file");
        await symlink(middle, link, "file");
      } catch (error) {
        if (
          process.platform === "win32"
          && error instanceof Error
          && "code" in error
          && ((error as NodeJS.ErrnoException).code === "EPERM"
            || (error as NodeJS.ErrnoException).code === "EACCES")
        ) {
          return;
        }
        throw error;
      }

      const before = await canonicalMutationPathKey(cwd, { path: "link.ts" });
      await writeFile(link, "export {};\n", "utf8");
      const after = await canonicalMutationPathKey(cwd, { path: "link.ts" });
      const direct = await canonicalMutationPathKey(cwd, { path: "target/new.ts" });

      expect(before).toBeDefined();
      expect(after).toBe(before);
      expect(direct).toBe(before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
