import { createHash } from "node:crypto";
import type {
  WorkspaceSessionRepairIssue,
} from "../shared/protocol.js";
import { validatePiSessionFile } from "./session-file.js";

export interface SessionRepairFingerprint {
  path: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface SessionFileRepairAnalysis {
  fileName: string;
  conversationId: string | null;
  revision: string;
  diagnostic?: string;
  repair: WorkspaceSessionRepairIssue["repair"];
  replacement?: Buffer;
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function revisionFor(
  fingerprint: Readonly<SessionRepairFingerprint>,
  bytes: Buffer,
): string {
  const contentSha = createHash("sha256").update(bytes).digest("hex");
  return createHash("sha256")
    .update(JSON.stringify([
      fingerprint.path,
      fingerprint.dev.toString(),
      fingerprint.ino.toString(),
      fingerprint.size.toString(),
      fingerprint.mtimeNs.toString(),
      fingerprint.ctimeNs.toString(),
      contentSha,
    ]))
    .digest("hex");
}

function headerConversationId(bytes: Buffer, path: string): string | null {
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) return null;
  try {
    return validatePiSessionFile(`${decodeUtf8(bytes.subarray(0, newline))}\n`, path);
  } catch {
    return null;
  }
}

function retainedEntryCount(validatedText: string): number {
  const lines = validatedText.split("\n");
  return lines.slice(1, -1).filter((line) => line.trim().length > 0).length;
}

function validatedCandidate(
  bytes: Buffer,
  path: string,
): { conversationId: string; text: string } | undefined {
  try {
    const text = decodeUtf8(bytes);
    return { conversationId: validatePiSessionFile(text, path), text };
  } catch {
    return undefined;
  }
}

function mayBeUnclosedObjectFragment(bytes: Buffer): boolean {
  const text = decodeUtf8(bytes);
  let start = 0;
  while (text[start] === " " || text.charCodeAt(start) === 9 || text.charCodeAt(start) === 13) {
    start += 1;
  }
  if (text[start] !== "{") return false;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character.charCodeAt(0) === 92) escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth <= 0) return false;
    }
  }
  return depth > 0;
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4096);
}

/** Proposes only byte-preserving newline/NUL edits or removal of one invalid unterminated tail. */
export function inspectSessionFileRepair(
  fileName: string,
  path: string,
  fingerprint: Readonly<SessionRepairFingerprint>,
  bytes: Buffer,
  includeReplacement = true,
): SessionFileRepairAnalysis {
  const revision = revisionFor(fingerprint, bytes);
  const originalConversationId = headerConversationId(bytes, path);
  let invalidReason: unknown;
  let text: string;

  try {
    text = decodeUtf8(bytes);
  } catch (error) {
    return {
      fileName,
      conversationId: originalConversationId,
      revision,
      diagnostic: diagnostic(error),
      repair: null,
    };
  }

  try {
    const conversationId = validatePiSessionFile(text, path);
    return { fileName, conversationId, revision, repair: null };
  } catch (error) {
    invalidReason = error;
  }

  const makeAnalysis = (
    conversationId: string,
    kind: NonNullable<WorkspaceSessionRepairIssue["repair"]>["kind"],
    removedBytes: number,
    validatedText: string,
    replacement: Buffer,
  ): SessionFileRepairAnalysis => ({
    fileName,
    conversationId,
    revision,
    diagnostic: diagnostic(invalidReason),
    repair: {
      kind,
      removedBytes,
      retainedEntries: retainedEntryCount(validatedText),
    },
    ...(includeReplacement ? { replacement } : {}),
  });

  const endsWithNewline = bytes.at(-1) === 0x0a;
  if (!endsWithNewline) {
    let nulStart = bytes.length;
    while (nulStart > 0 && bytes[nulStart - 1] === 0) nulStart -= 1;
    if (nulStart < bytes.length) {
      const withoutNuls = bytes.subarray(0, nulStart);
      try {
        let candidateText = decodeUtf8(withoutNuls);
        let replacement = withoutNuls;
        if (!candidateText.endsWith("\n")) {
          candidateText += "\n";
          replacement = Buffer.concat([withoutNuls, Buffer.from("\n")]);
        }
        const conversationId = validatePiSessionFile(candidateText, path);
        return makeAnalysis(
          conversationId,
          "remove_zero_tail",
          bytes.length - nulStart,
          candidateText,
          replacement,
        );
      } catch {
        // A zero suffix is removable only when the resulting whole session validates.
      }
    }

    const newlineCandidate = Buffer.concat([bytes, Buffer.from("\n")]);
    const newlineValidation = validatedCandidate(newlineCandidate, path);
    if (newlineValidation !== undefined) {
      return makeAnalysis(
        newlineValidation.conversationId,
        "append_newline",
        0,
        newlineValidation.text,
        newlineCandidate,
      );
    }

    const tailStart = bytes.lastIndexOf(0x0a) + 1;
    const prefix = bytes.subarray(0, tailStart);
    const tail = bytes.subarray(tailStart);
    if (tail.length > 0) {
      const prefixValidation = validatedCandidate(prefix, path);
      // A syntactically valid final JSON value may still be an invalid Pi entry;
      // that is corruption, not an incomplete fragment we may discard.
      let jsonTail = tail;
      while (jsonTail.length > 0 && jsonTail[jsonTail.length - 1] === 0) {
        jsonTail = jsonTail.subarray(0, jsonTail.length - 1);
      }
      if (
        prefixValidation !== undefined
        && jsonTail.length > 0
        && mayBeUnclosedObjectFragment(jsonTail)
      ) {
        return makeAnalysis(
          prefixValidation.conversationId,
          "discard_incomplete_tail",
          tail.length,
          prefixValidation.text,
          prefix,
        );
      }
    }
  }

  return {
    fileName,
    conversationId: originalConversationId,
    revision,
    diagnostic: diagnostic(invalidReason),
    repair: null,
  };
}

export function formatRepairError(error: unknown): string {
  return diagnostic(error);
}
