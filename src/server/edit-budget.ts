import { readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EDIT_BUDGET_CUSTOM_TYPE = "piweb.edit_budget.v1";
export const MAX_EDIT_BUDGET_FILES_PER_REQUEST = 100;
export const MAX_EDIT_BUDGET_REASON_CHARACTERS = 2_000;
export const MAX_EDIT_BUDGET_PATH_KEY_BYTES = 32 * 1024;

/** A non-context, append-only proof of an edit-budget decision. */
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

export interface EditBudgetLedger {
  grantedFiles: number;
  /** Paths durably authorized before their builtin call was allowed to run. */
  readonly chargedPathKeys: Set<string>;
  /** Paths whose successful modification this live process actually observed. */
  readonly touchedPathKeys: Set<string>;
  blockedAttempts: number;
}

export interface EditBudgetSnapshot {
  grantedFiles: number;
  chargedFiles: number;
  touchedFiles: number;
  remainingFiles: number;
  blockedAttempts: number;
}

export function createEditBudgetLedger(): EditBudgetLedger {
  return {
    grantedFiles: 0,
    chargedPathKeys: new Set(),
    touchedPathKeys: new Set(),
    blockedAttempts: 0,
  };
}

export function snapshotEditBudget(
  ledger: EditBudgetLedger,
): EditBudgetSnapshot {
  const chargedFiles = ledger.chargedPathKeys.size;
  return {
    grantedFiles: ledger.grantedFiles,
    chargedFiles,
    touchedFiles: ledger.touchedPathKeys.size,
    remainingFiles: Math.max(0, ledger.grantedFiles - chargedFiles),
    blockedAttempts: ledger.blockedAttempts,
  };
}

function applyEditBudgetEvent(
  ledger: EditBudgetLedger,
  event: EditBudgetEvent,
): void {
  if (event.kind === "grant") {
    ledger.grantedFiles = event.fileCount;
    return;
  }
  if (
    !ledger.chargedPathKeys.has(event.pathKey)
    && snapshotEditBudget(ledger).remainingFiles === 0
  ) {
    throw new Error(
      `Edit budget charge exceeds the granted file count for run ${event.runId}`,
    );
  }
  ledger.chargedPathKeys.add(event.pathKey);
}

/**
 * Replays exact-run entries in transcript order. A charge is deliberately
 * irreversible: a builtin write can take effect before it later reports an
 * error or observes abort, so only a durable pre-call charge survives safely.
 */
export function restoreEditBudgetLedger(
  events: readonly EditBudgetEvent[],
  runId: string,
): EditBudgetLedger {
  const ledger = createEditBudgetLedger();
  for (const event of events) {
    if (event.runId === runId) applyEditBudgetEvent(ledger, event);
  }
  return ledger;
}

/** Validates every run's independent journal without granting cross-run state. */
export function validateEditBudgetEvents(
  events: readonly EditBudgetEvent[],
): void {
  const ledgers = new Map<string, EditBudgetLedger>();
  for (const event of events) {
    let ledger = ledgers.get(event.runId);
    if (ledger === undefined) {
      ledger = createEditBudgetLedger();
      ledgers.set(event.runId, ledger);
    }
    applyEditBudgetEvent(ledger, event);
  }
}

export function isBuiltinFileMutation(
  toolName: string,
  toolSource: string,
): boolean {
  return toolSource === "builtin"
    && (toolName === "edit" || toolName === "write");
}

function normalizePiPath(value: string): string {
  let normalized = value.replace(
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,
    " ",
  );
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (
    process.platform === "win32"
    && normalized.startsWith("/")
    && !normalized.startsWith("//")
    && !normalized.includes("\\")
  ) {
    const shellPath = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(
      normalized,
    );
    if (shellPath) {
      normalized = `${shellPath[1]!.toUpperCase()}:\\${
        shellPath[2]?.replaceAll("/", "\\") ?? ""
      }`;
    }
  }
  if (normalized === "~") {
    normalized = homedir();
  } else if (
    normalized.startsWith("~/")
    || (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    normalized = path.join(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    normalized = fileURLToPath(normalized);
  }
  return normalized;
}

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

async function canonicalizeMissingPath(
  absolutePath: string,
  seenSymlinks = new Set<string>(),
): Promise<string> {
  const suffix: string[] = [];
  let candidate = absolutePath;
  for (;;) {
    try {
      return path.join(await realpath(candidate), ...suffix);
    } catch (error) {
      const code = filesystemErrorCode(error);
      // A non-directory parent is not a createable missing target. Keep Pi's
      // existing lexical identity and let the builtin tool report its failure.
      if (code === "ENOTDIR") return absolutePath;
      if (code !== "ENOENT") throw error;

      let target: string | undefined;
      try {
        target = await readlink(candidate);
      } catch (readError) {
        const readCode = filesystemErrorCode(readError);
        if (readCode !== "ENOENT" && readCode !== "EINVAL") throw readError;
      }
      if (target !== undefined) {
        const key = process.platform === "win32"
          ? candidate.toLowerCase()
          : candidate;
        if (seenSymlinks.has(key)) {
          throw new Error("Cannot canonicalize a cyclic dangling symlink");
        }
        seenSymlinks.add(key);
        const resolvedTarget = path.resolve(path.dirname(candidate), target);
        return canonicalizeMissingPath(
          path.join(resolvedTarget, ...suffix),
          seenSymlinks,
        );
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) return absolutePath;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function mutationPathArgument(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return undefined;
  }
  const candidate = (args as { path?: unknown }).path;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Returns the same lexical target used by Pi's builtin edit/write tools, then
 * folds existing symlink aliases. This is an accounting identity, not a cwd
 * containment check.
 */
export async function canonicalMutationPathKey(
  cwd: string,
  args: unknown,
): Promise<string | undefined> {
  const rawPath = mutationPathArgument(args);
  if (rawPath === undefined) return undefined;

  let absolutePath: string;
  try {
    const normalized = normalizePiPath(rawPath);
    if (normalized.length === 0) return undefined;
    absolutePath = path.resolve(cwd, normalized);
  } catch {
    return undefined;
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    const code = filesystemErrorCode(error);
    // Resolve a missing target from its nearest existing parent, following
    // dangling symlink chains so creation keeps the same identity later.
    if (code === "ENOENT") {
      canonicalPath = await canonicalizeMissingPath(absolutePath);
    } else if (code === "ENOTDIR") {
      canonicalPath = absolutePath;
    } else {
      throw error;
    }
  }
  const normalizedKey = path.normalize(canonicalPath);
  return process.platform === "win32"
    ? normalizedKey.toLowerCase()
    : normalizedKey;
}
