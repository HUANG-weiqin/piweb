import {
  buildSessionProjection,
  convertToLlm,
  type ProjectedSessionEntry,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  FORK_CONTEXT_CUSTOM_TYPE,
  createConversationMetaEntry,
  type ConversationMeta,
} from "./conversation-meta.js";
import {
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  type ServiceTier,
  type ThinkingLevel,
} from "../shared/protocol.js";

/**
 * Current-leaf fork.
 *
 * A fork copies the current LLM-effective context and rebuilds a fresh host
 * lifecycle. It never copies JSONL bytes, run ledgers, cards, receipts,
 * LoopList state, or pre-compaction text covered by the latest summary.
 */

export { FORK_CONTEXT_CUSTOM_TYPE };

const FORK_SESSION_NAME_SUFFIX = " 副本";

/**
 * Keep fork titles distinguishable from their source in grouped views that
 * fall back to the session name.
 */
function forkSessionName(sourceName: string): string {
  const suffixChars = [...FORK_SESSION_NAME_SUFFIX];
  const nameChars = [...sourceName];
  if (
    nameChars.length + suffixChars.length
      <= MAX_PROJECT_CONVERSATION_NAME_CHARACTERS
  ) {
    return `${sourceName}${FORK_SESSION_NAME_SUFFIX}`;
  }
  return `${
    nameChars
      .slice(0, MAX_PROJECT_CONVERSATION_NAME_CHARACTERS - suffixChars.length)
      .join("")
  }${FORK_SESSION_NAME_SUFFIX}`;
}

const forkContextDetailsSchema = z.object({
  forkedFromConversationId: z.string().min(1).max(256),
  forkedAt: z.string().datetime(),
}).strict();

export type ForkContextDetails = z.infer<typeof forkContextDetailsSchema>;

const SESSION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function parseForkContextDetails(value: unknown): ForkContextDetails {
  return forkContextDetailsSchema.parse(value);
}

export interface ForkSourceSnapshot {
  readonly sourceConversationId: string;
  readonly sourceLeafId: string | null;
  /** Frozen physical active-branch entries (root → leaf). */
  readonly branch: readonly SessionEntry[];
  readonly profile: ConversationMeta;
  readonly thinkingLevel: ThinkingLevel;
  readonly serviceTier: ServiceTier | null;
  readonly compactionThresholdPercent: number;
  readonly capturedAt: string;
  /** Latest session_info name; undefined stays nameless. */
  readonly sessionName: string | undefined;
}

export function createForkSourceSnapshot(input: {
  sourceConversationId: string;
  sourceLeafId: string | null;
  branch: readonly SessionEntry[];
  profile: ConversationMeta;
  thinkingLevel: ThinkingLevel;
  serviceTier: ServiceTier | null;
  compactionThresholdPercent: number;
  capturedAt: string;
  sessionName: string | undefined;
}): ForkSourceSnapshot {
  if (!SESSION_ID_PATTERN.test(input.sourceConversationId)) {
    throw new Error("Fork source conversationId must be a valid Pi session id");
  }
  if (
    input.sourceLeafId !== null
    && !SESSION_ID_PATTERN.test(input.sourceLeafId)
  ) {
    throw new Error("Fork source leaf id must be a valid Pi entry id");
  }
  if (
    Number.isNaN(Date.parse(input.capturedAt))
    || new Date(input.capturedAt).toISOString() !== input.capturedAt
  ) {
    throw new Error("Fork capturedAt must be a canonical ISO timestamp");
  }
  return {
    sourceConversationId: input.sourceConversationId,
    sourceLeafId: input.sourceLeafId,
    branch: structuredClone([...input.branch]),
    profile: structuredClone(input.profile),
    thinkingLevel: input.thinkingLevel,
    serviceTier: input.serviceTier,
    compactionThresholdPercent: input.compactionThresholdPercent,
    capturedAt: input.capturedAt,
    sessionName: input.sessionName,
  };
}

type SourceMessage = Extract<SessionEntry, { type: "message" }>["message"];
type ForkCustomContent = Parameters<
  SessionManager["appendCustomMessageEntry"]
>[1];

export type PlannedForkEntry =
  | {
      readonly kind: "message";
      readonly sourceId: string;
      readonly message: SourceMessage;
    }
  | {
      readonly kind: "fork_context";
      readonly sourceId: string;
      readonly sourceType: string;
      readonly sourceCustomType?: string;
      readonly content: ForkCustomContent;
    };

export interface PlannedFork {
  readonly retained: readonly PlannedForkEntry[];
  readonly latestCompaction: {
    readonly sourceId: string;
    readonly summary: string;
    readonly tokensBefore: number;
    readonly details: unknown;
    readonly fromHook: boolean | undefined;
    readonly usage: unknown;
    readonly firstKeptEntryId: string;
    readonly systemMessage: Extract<SessionEntry, { type: "compaction" }>["systemMessage"];
  } | null;
  readonly post: readonly PlannedForkEntry[];
}

function toForkContext(
  sourceId: string,
  sourceType: "branch_summary" | "custom_message",
  message: ProjectedSessionEntry["messages"][number],
  sourceCustomType?: string,
): PlannedForkEntry {
  const projected = convertToLlm([message])[0]! as UserMessage;
  return {
    kind: "fork_context",
    sourceId,
    sourceType,
    ...(sourceCustomType === undefined ? {} : { sourceCustomType }),
    content: structuredClone(projected.content),
  };
}

function canonicalizeProjectedEntry(
  projected: ProjectedSessionEntry,
): PlannedForkEntry | null {
  const entry = projected.sourceEntry;
  switch (entry.type) {
    case "message": {
      const message = projected.messages[0];
      return message === undefined
        ? null
        : {
            kind: "message",
            sourceId: entry.id,
            message: structuredClone(message),
          };
    }
    case "branch_summary": {
      const message = projected.messages[0];
      return message === undefined
        ? null
        : toForkContext(entry.id, entry.type, message);
    }
    case "custom_message": {
      const message = projected.messages[0];
      return message === undefined
        ? null
        : toForkContext(entry.id, entry.type, message, entry.customType);
    }
    default:
      // Pi's projection has already applied context edits and compaction
      // visibility. State-only entries and older compaction summaries contribute
      // no provider context here; effective role settings are staged separately.
      return null;
  }
}

function canonicalizeProjectionRange(
  branch: readonly SessionEntry[],
  projectedById: ReadonlyMap<string, ProjectedSessionEntry>,
  start: number,
  end: number,
): PlannedForkEntry[] {
  const planned: PlannedForkEntry[] = [];
  for (let index = start; index < end; index += 1) {
    const projected = projectedById.get(branch[index]!.id);
    if (projected === undefined) continue;
    const entry = canonicalizeProjectedEntry(projected);
    if (entry !== null) planned.push(entry);
  }
  return planned;
}

/**
 * Split a frozen physical active branch using Pi's canonical provider projection.
 * Older compactions and context-edit carriers with no projected messages are not
 * materialized; edits are reflected in their projected source messages.
 */
export function planForkEntries(
  snapshot: ForkSourceSnapshot,
): PlannedFork {
  const branch = [...snapshot.branch];
  const projection = buildSessionProjection(branch);
  const projectedById = new Map(
    projection.entries.map((entry) => [entry.sourceEntry.id, entry]),
  );

  let latestIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "compaction") {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex === -1) {
    return {
      retained: [],
      latestCompaction: null,
      post: canonicalizeProjectionRange(branch, projectedById, 0, branch.length),
    };
  }

  const latest = branch[latestIndex]!;
  if (latest.type !== "compaction") {
    throw new Error("Fork planner reached an impossible branch state");
  }
  const firstKeptIndex = branch.findIndex(
    (entry) => entry.id === latest.firstKeptEntryId,
  );
  if (firstKeptIndex === -1 || firstKeptIndex > latestIndex) {
    throw new Error(
      "Fork source has a compaction whose retained range is not on its active branch",
    );
  }
  return {
    retained: canonicalizeProjectionRange(
      branch,
      projectedById,
      firstKeptIndex,
      latestIndex,
    ),
    latestCompaction: {
      sourceId: latest.id,
      summary: latest.summary,
      tokensBefore: latest.tokensBefore,
      details: structuredClone(latest.details),
      fromHook: latest.fromHook,
      usage: structuredClone(latest.usage),
      firstKeptEntryId: latest.firstKeptEntryId,
      systemMessage: structuredClone(latest.systemMessage),
    },
    post: canonicalizeProjectionRange(
      branch,
      projectedById,
      latestIndex + 1,
      branch.length,
    ),
  };
}

export function buildForkChildProfile(
  snapshot: ForkSourceSnapshot,
  forkedAt: string,
  sourceLeafId: string | null,
): ConversationMeta {
  const child = structuredClone(snapshot.profile);
  child.createdBy = { kind: "user" };
  delete child.orchestration;
  return createConversationMetaEntry({
    ...child,
    forkedFrom: {
      sourceConversationId: snapshot.sourceConversationId,
      ...(sourceLeafId === null ? {} : { sourceLeafId }),
      forkedAt,
    },
  }).data;
}

export interface AppliedForkSeed {
  readonly metaEntryId: string;
  readonly firstKeptEntryId: string;
  readonly compactionEntryId: string | null;
}

/**
 * Stage a fork seed into an in-memory SessionManager.
 * The caller owns atomic publication; this function never touches disk.
 */
export function applyForkSeedToManager(
  manager: SessionManager,
  snapshot: ForkSourceSnapshot,
  options: {
    forkedAt: string;
    compactionThresholdUpdatedAt: string;
    serviceTierUpdatedAt: string;
  },
): AppliedForkSeed {
  const planned = planForkEntries(snapshot);
  const childProfile = buildForkChildProfile(
    snapshot,
    options.forkedAt,
    snapshot.sourceLeafId,
  );
  const meta = createConversationMetaEntry(childProfile);
  const metaEntryId = manager.appendCustomEntry(meta.customType, meta.data);

  manager.appendThinkingLevelChange(snapshot.thinkingLevel);
  manager.appendCustomEntry("piweb.service_tier.v1", {
    tier: snapshot.serviceTier,
    updatedAt: options.serviceTierUpdatedAt,
  });
  manager.appendCustomEntry("piweb.compaction_threshold.v1", {
    percent: snapshot.compactionThresholdPercent,
    updatedAt: options.compactionThresholdUpdatedAt,
  });

  if (snapshot.sessionName !== undefined) {
    manager.appendSessionInfo(forkSessionName(snapshot.sessionName));
  }

  const appendPlanned = (entry: PlannedForkEntry): string => {
    if (entry.kind === "message") {
      return manager.appendMessage(structuredClone(entry.message) as never);
    }
    const details: ForkContextDetails = {
      forkedFromConversationId: snapshot.sourceConversationId,
      forkedAt: options.forkedAt,
    };
    parseForkContextDetails(details);
    const content = typeof entry.content === "string"
      ? entry.content
      : structuredClone(entry.content);
    return manager.appendCustomMessageEntry(
      FORK_CONTEXT_CUSTOM_TYPE,
      content,
      false,
      details,
    );
  };

  let firstKeptEntryId = metaEntryId;
  const firstRetained = planned.retained[0];
  for (const entry of planned.retained) {
    const id = appendPlanned(entry);
    if (firstRetained !== undefined && entry === firstRetained) {
      firstKeptEntryId = id;
    }
  }

  let compactionEntryId: string | null = null;
  if (planned.latestCompaction) {
    if (planned.latestCompaction.systemMessage) {
      manager.appendMessage(
        structuredClone(planned.latestCompaction.systemMessage),
      );
    }
    const firstKeptId = planned.latestCompaction.firstKeptEntryId
        === planned.latestCompaction.sourceId
      ? null
      : firstKeptEntryId;
    compactionEntryId = manager.appendCompaction(
      planned.latestCompaction.summary,
      firstKeptId,
      planned.latestCompaction.tokensBefore,
      planned.latestCompaction.details,
      planned.latestCompaction.fromHook,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      planned.latestCompaction.usage as any,
    );
    firstKeptEntryId = firstKeptId ?? compactionEntryId;
  }
  for (const entry of planned.post) {
    appendPlanned(entry);
  }
  return { metaEntryId, firstKeptEntryId, compactionEntryId };
}
