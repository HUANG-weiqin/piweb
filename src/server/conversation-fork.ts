import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  FORK_CONTEXT_CUSTOM_TYPE,
  createConversationMetaEntry,
  type ConversationMeta,
} from "./conversation-meta.js";
import type {
  ServiceTier,
  ThinkingLevel,
} from "../shared/protocol.js";

/**
 * Current-leaf fork.
 *
 * A fork copies the current LLM-effective context and rebuilds a fresh host
 * lifecycle. It never copies JSONL bytes, run ledgers, cards, receipts,
 * LoopList state, or pre-compaction text covered by the latest summary.
 */

export { FORK_CONTEXT_CUSTOM_TYPE };

// Must match Pi 0.85.1 `core/messages.js`. The fork test proves equivalence
// through the real SDK `convertToLlm`, so an SDK upgrade that changes these
// prefixes fails fast instead of silently diverging child context.
const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";

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
  } | null;
  readonly post: readonly PlannedForkEntry[];
}

function toForkContextForOlderCompaction(
  entry: Extract<SessionEntry, { type: "compaction" }>,
): PlannedForkEntry {
  return {
    kind: "fork_context",
    sourceId: entry.id,
    sourceType: "compaction",
    content: `${COMPACTION_SUMMARY_PREFIX}${entry.summary}${COMPACTION_SUMMARY_SUFFIX}`,
  };
}

function toForkContextForBranchSummary(
  entry: Extract<SessionEntry, { type: "branch_summary" }>,
): PlannedForkEntry {
  return {
    kind: "fork_context",
    sourceId: entry.id,
    sourceType: "branch_summary",
    content: `${BRANCH_SUMMARY_PREFIX}${entry.summary}${BRANCH_SUMMARY_SUFFIX}`,
  };
}

function toForkContextForCustomMessage(
  entry: Extract<SessionEntry, { type: "custom_message" }>,
): PlannedForkEntry {
  const content = typeof entry.content === "string"
    ? entry.content
    : structuredClone(entry.content);
  return {
    kind: "fork_context",
    sourceId: entry.id,
    sourceType: "custom_message",
    sourceCustomType: entry.customType,
    content,
  };
}

function canonicalizePhysicalEntry(
  entry: SessionEntry,
): PlannedForkEntry | null {
  switch (entry.type) {
    case "message":
      return {
        kind: "message",
        sourceId: entry.id,
        message: structuredClone(entry.message),
      };
    case "compaction":
      return toForkContextForOlderCompaction(entry);
    case "branch_summary":
      return toForkContextForBranchSummary(entry);
    case "custom_message":
      return toForkContextForCustomMessage(entry);
    default:
      // thinking_level_change, model_change, custom (ledger), label,
      // session_info: never part of the forked effective context. Fresh
      // effective settings are materialized explicitly by the stager.
      return null;
  }
}

/**
 * Split a frozen physical active branch into retained / latest / post.
 * Covered pre-compaction text is never returned.
 */
export function planForkEntries(
  snapshot: ForkSourceSnapshot,
): PlannedFork {
  const branch = [...snapshot.branch];
  let latestIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "compaction") {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex === -1) {
    const post: PlannedForkEntry[] = [];
    for (const entry of branch) {
      const planned = canonicalizePhysicalEntry(entry);
      if (planned) post.push(planned);
    }
    return { retained: [], latestCompaction: null, post };
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
  const retained: PlannedForkEntry[] = [];
  for (let index = firstKeptIndex; index < latestIndex; index += 1) {
    const planned = canonicalizePhysicalEntry(branch[index]!);
    if (planned) retained.push(planned);
  }
  const post: PlannedForkEntry[] = [];
  for (let index = latestIndex + 1; index < branch.length; index += 1) {
    const planned = canonicalizePhysicalEntry(branch[index]!);
    if (planned) post.push(planned);
  }
  return {
    retained,
    latestCompaction: {
      sourceId: latest.id,
      summary: latest.summary,
      tokensBefore: latest.tokensBefore,
      details: structuredClone(latest.details),
      fromHook: latest.fromHook,
      usage: structuredClone(latest.usage),
    },
    post,
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
    manager.appendSessionInfo(snapshot.sessionName);
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
    compactionEntryId = manager.appendCompaction(
      planned.latestCompaction.summary,
      firstKeptEntryId,
      planned.latestCompaction.tokensBefore,
      planned.latestCompaction.details,
      planned.latestCompaction.fromHook,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      planned.latestCompaction.usage as any,
    );
  }
  for (const entry of planned.post) {
    appendPlanned(entry);
  }
  return { metaEntryId, firstKeptEntryId, compactionEntryId };
}
