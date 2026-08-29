import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_EDIT_BUDGET_FILES_PER_REQUEST = 100;
export const MAX_EDIT_BUDGET_REASON_CHARACTERS = 2_000;

export interface EditBudgetLedger {
  grantedFiles: number;
  readonly touchedPathKeys: Set<string>;
  blockedAttempts: number;
}

export interface EditBudgetSnapshot {
  grantedFiles: number;
  touchedFiles: number;
  remainingFiles: number;
  blockedAttempts: number;
}

export function createEditBudgetLedger(): EditBudgetLedger {
  return {
    grantedFiles: 0,
    touchedPathKeys: new Set(),
    blockedAttempts: 0,
  };
}

export function snapshotEditBudget(
  ledger: EditBudgetLedger,
): EditBudgetSnapshot {
  const touchedFiles = ledger.touchedPathKeys.size;
  return {
    grantedFiles: ledger.grantedFiles,
    touchedFiles,
    remainingFiles: Math.max(0, ledger.grantedFiles - touchedFiles),
    blockedAttempts: ledger.blockedAttempts,
  };
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

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (
      (error as { code?: unknown }).code === "ENOENT"
      || (error as { code?: unknown }).code === "ENOTDIR"
    );
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

  let canonicalPath = absolutePath;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    // Pi's mutation queue also keeps the lexical absolute path when the target
    // does not yet exist, but propagates other filesystem failures.
    if (!isMissingPathError(error)) throw error;
  }
  const normalizedKey = path.normalize(canonicalPath);
  return process.platform === "win32"
    ? normalizedKey.toLowerCase()
    : normalizedKey;
}
