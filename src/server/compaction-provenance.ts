import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type {
  ConversationCompactionProvenance,
  PublicCompactionAttempt,
} from "../shared/protocol.js";

export const COMPACTION_PROVENANCE_NAMESPACE = "piweb.compaction_provenance.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DurableDefaultCompactionProvenance {
  version: 1;
  attemptId: string;
  generator: "default";
  policy: "follow_primary" | "explicit";
  requestTarget: {
    provider: string;
    id: string;
  };
}

export type DefaultCompactionAttemptObserver = (
  event:
    | { type: "started"; attempt: PublicCompactionAttempt }
    | { type: "ended"; id: string },
) => void;

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  if (nodeTypes.isProxy(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  return value as Record<string, unknown>;
}

function ownDataProperty(
  value: Record<string, unknown>,
  key: string,
): unknown | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return;
  return descriptor.value;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === "string" && keys.includes(key));
}

function validRequestTarget(value: unknown): value is { provider: string; id: string } {
  const target = plainRecord(value);
  return target !== undefined
    && hasExactKeys(target, ["provider", "id"])
    && typeof ownDataProperty(target, "provider") === "string"
    && ownDataProperty(target, "provider") !== ""
    && typeof ownDataProperty(target, "id") === "string"
    && ownDataProperty(target, "id") !== "";
}

function validDurableDefaultProvenance(
  value: unknown,
): value is DurableDefaultCompactionProvenance {
  const provenance = plainRecord(value);
  if (
    provenance === undefined
    || !hasExactKeys(provenance, [
      "version",
      "attemptId",
      "generator",
      "policy",
      "requestTarget",
    ])
  ) {
    return false;
  }
  const attemptId = ownDataProperty(provenance, "attemptId");
  const policy = ownDataProperty(provenance, "policy");
  return ownDataProperty(provenance, "version") === 1
    && ownDataProperty(provenance, "generator") === "default"
    && typeof attemptId === "string"
    && UUID_PATTERN.test(attemptId)
    && (policy === "follow_primary" || policy === "explicit")
    && validRequestTarget(ownDataProperty(provenance, "requestTarget"));
}

function assertJsonSafe(value: unknown, label: string, visiting: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} contains a non-JSON value`);
  if (nodeTypes.isProxy(value)) throw new Error(`${label} contains a Proxy`);
  if (visiting.has(value)) throw new Error(`${label} contains a cycle`);

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Error(`${label} contains a non-plain object`);
  }

  visiting.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (array) {
      if (
        keys.length !== value.length + 1
        || !keys.includes("length")
        || keys.some((key) => typeof key !== "string")
      ) {
        throw new Error(`${label} contains a non-JSON array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error(`${label} contains a non-JSON array entry`);
        }
        assertJsonSafe(descriptor.value, label, visiting);
      }
      return;
    }

    for (const key of keys) {
      if (typeof key !== "string") throw new Error(`${label} contains a symbol property`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${label} contains an accessor or hidden property`);
      }
      assertJsonSafe(descriptor.value, label, visiting);
    }
  } finally {
    visiting.delete(value);
  }
}

function assertJsonSafePlainRecord(value: unknown, label: string): Record<string, unknown> {
  const record = plainRecord(value);
  if (record === undefined) throw new Error(`${label} must be a plain record`);
  assertJsonSafe(record, label, new WeakSet<object>());
  return record;
}

function durableProvenance(
  attempt: PublicCompactionAttempt,
): DurableDefaultCompactionProvenance {
  return {
    version: 1,
    attemptId: attempt.id,
    generator: "default",
    policy: attempt.policy,
    requestTarget: {
      provider: attempt.requestTarget.provider,
      id: attempt.requestTarget.id,
    },
  };
}

export function createDefaultCompactionAttempt(
  policy: PublicCompactionAttempt["policy"],
  requestTarget: PublicCompactionAttempt["requestTarget"],
): PublicCompactionAttempt {
  return {
    id: randomUUID(),
    generator: "default",
    policy,
    requestTarget: {
      provider: requestTarget.provider,
      id: requestTarget.id,
    },
  };
}

/**
 * Adds only the host namespace to Pi's default compaction details. Pi keeps
 * owning every other detail, including its file-tracking fields.
 */
export function mergeDefaultCompactionProvenance(
  details: unknown,
  attempt: PublicCompactionAttempt,
): Record<string, unknown> {
  const durable = durableProvenance(attempt);
  if (details === undefined) {
    return { [COMPACTION_PROVENANCE_NAMESPACE]: durable };
  }

  const existing = assertJsonSafePlainRecord(details, "Pi compaction details");
  if (Object.hasOwn(existing, COMPACTION_PROVENANCE_NAMESPACE)) {
    throw new Error("Pi compaction details already contain the host provenance namespace");
  }

  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(existing)) {
    const descriptor = Object.getOwnPropertyDescriptor(existing, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("Pi compaction details changed during provenance merge");
    }
    Object.defineProperty(merged, key, descriptor);
  }
  Object.defineProperty(merged, COMPACTION_PROVENANCE_NAMESPACE, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: durable,
  });
  return merged;
}

/** Returns a browser-safe marker only for a strict host-owned durable envelope. */
export function projectDefaultCompactionProvenance(
  details: unknown,
): Extract<ConversationCompactionProvenance, { generator: "default" }> | undefined {
  const detailsRecord = plainRecord(details);
  if (detailsRecord === undefined) return;
  const provenance = ownDataProperty(detailsRecord, COMPACTION_PROVENANCE_NAMESPACE);
  if (!validDurableDefaultProvenance(provenance)) return;
  return {
    generator: "default",
    attemptId: provenance.attemptId,
    policy: provenance.policy,
    requestTarget: {
      provider: provenance.requestTarget.provider,
      id: provenance.requestTarget.id,
    },
  };
}
