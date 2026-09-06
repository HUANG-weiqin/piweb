import { readlink, realpath } from "node:fs/promises";
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
