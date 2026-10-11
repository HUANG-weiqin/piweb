import type {
  LoopList,
  LoopListItemStatus,
  WorkspaceChangesSnapshot,
} from "../../shared/protocol";
import { WorkspaceChangesPanel } from "./WorkspaceChangesPanel";

const MISSION_OBJECTIVE_STATUS_LABELS: Record<LoopListItemStatus, string> = {
  pending: "REMAINING",
  active: "CURRENT",
  completed: "CLEARED",
};

const OUTPUT_RATE_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 3,
  useGrouping: false,
});

function formatOutputTokenRate(tokensPerSecond: number, estimated = false): string {
  const value = tokensPerSecond >= 1_000
    ? `${OUTPUT_RATE_NUMBER_FORMAT.format(tokensPerSecond / 1_000)}k`
    : OUTPUT_RATE_NUMBER_FORMAT.format(tokensPerSecond);
  return `${estimated ? "~ " : ""}${value} TOK/S`;
}

export type MissionCommandStatus = "paused" | "executing" | "completed";
export type MissionCommandView = "objectives" | "changes";

interface MissionCommandSurfaceProps {
  view: MissionCommandView;
  showWorkspaceChanges: boolean;
  workspaceChanges?: WorkspaceChangesSnapshot;
  workspaceChangesLoading?: boolean;
  onRefreshWorkspaceChanges?(): void;
  onSelectView(view: MissionCommandView): void;
  loopListItems: LoopList["items"];
  completedItemCount: number;
  remainingItemCount: number;
  loopListStatusKey?: MissionCommandStatus;
  loopListStatusLabel?: string;
  contextTokenText: string;
  outputTokensPerSecond?: number;
  outputRateEstimated: boolean;
  contextPercent: number | null | undefined;
  contextSource: "measured" | "estimated" | "unknown" | undefined;
  compactionThresholdPercent: number;
}

export function MissionCommandSurface({
  view,
  showWorkspaceChanges,
  workspaceChanges,
  workspaceChangesLoading,
  onRefreshWorkspaceChanges,
  onSelectView,
  loopListItems,
  completedItemCount,
  remainingItemCount,
  loopListStatusKey,
  loopListStatusLabel,
  contextTokenText,
  outputTokensPerSecond,
  outputRateEstimated,
  contextPercent,
  contextSource,
  compactionThresholdPercent,
}: MissionCommandSurfaceProps) {
  const meterPercent = contextPercent == null
    ? undefined
    : Math.min(100, Math.max(0, contextPercent));

  return <aside className="mission-command" aria-label="Mission Command">
    <header className="mission-command-header">
      <p className="mission-command-kicker">
        <span>MISSION</span>
        {view === "objectives" && loopListStatusLabel && <span
          className={`mission-command-status is-${loopListStatusKey}`}
        >STATUS · {loopListStatusLabel}</span>}
      </p>
      {showWorkspaceChanges && <div className="mission-view-tabs" role="group" aria-label="Mission view">
        <button type="button" aria-pressed={view === "objectives"} onClick={() => onSelectView("objectives")}>
          OBJECTIVES
        </button>
        <button type="button" aria-pressed={view === "changes"} onClick={() => onSelectView("changes")}>
          工作区改动
        </button>
      </div>}
      <div className="mission-command-title-row">
        <h2>{view === "changes" ? "WORKSPACE CHANGES" : "OBJECTIVES"}</h2>
        {view === "objectives" && <p
          className="mission-objective-count"
          aria-label={`${remainingItemCount} 个未完成目标`}
        >
          <strong>{remainingItemCount}</strong>
          <span>REMAINING<br />{completedItemCount} CLEARED</span>
        </p>}
      </div>
    </header>

    {view === "changes" && showWorkspaceChanges
      ? <WorkspaceChangesPanel
        snapshot={workspaceChanges}
        loading={workspaceChangesLoading}
        onRefresh={onRefreshWorkspaceChanges}
      />
      : <section className="mission-objectives" aria-label="Objectives">
        {loopListItems.length === 0
          ? <p className="mission-objectives-empty">当前没有计划目标。</p>
          : <ol className="mission-objective-list">
            {loopListItems.map((item) => <li
              key={item.id}
              className={`mission-objective is-${item.status}`}
            >
              <span className="mission-objective-mark" aria-hidden="true" />
              <span className="mission-objective-copy">
                <small>{MISSION_OBJECTIVE_STATUS_LABELS[item.status]}</small>
                <span>{item.text}</span>
              </span>
            </li>)}
          </ol>}
      </section>}

    <section className="mission-context" aria-label="Context Compaction">
      <div className="mission-section-heading">
        <h3>CONTEXT COMPACTION</h3>
        <span>{contextSource?.toUpperCase() ?? "UNKNOWN"}</span>
      </div>
      {meterPercent === undefined
        ? <div className="mission-context-meter is-unknown" aria-hidden="true" />
        : <div
          className="mission-context-meter"
          role="meter"
          aria-label={`上下文使用 ${Math.round(contextPercent!)}%`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(contextPercent!)}
        >
          <span style={{ width: `${meterPercent}%` }} />
        </div>}
      <p className="mission-context-reading">{contextTokenText}</p>
      <p className="mission-context-rate">
        <span>AVG OUTPUT RATE</span>
        <strong>{outputTokensPerSecond === undefined
          ? "—"
          : formatOutputTokenRate(outputTokensPerSecond, outputRateEstimated)}</strong>
      </p>
      <p className="mission-context-threshold">
        AUTO COMPACT <strong>{compactionThresholdPercent}%</strong>
      </p>
    </section>

  </aside>;
}
