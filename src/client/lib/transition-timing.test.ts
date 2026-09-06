import { describe, expect, it, vi } from "vitest";
import {
  createTransitionTimingOwner,
  MAX_RETAINED_TRANSITION_MEASURES,
  TRANSITION_PERFORMANCE_ENTRY_NAME,
  type TransitionMeasureDetail,
} from "./transition-timing";

function intent(
  kind: "workspace" | "conversation" = "conversation",
  suffix = "a",
) {
  return {
    kind,
    sessionId: `session-${suffix}`,
    commandId: `command-${suffix}`,
    origin: "user" as const,
    intentViewport: "desktop" as const,
    cacheAtIntent: "miss" as const,
  };
}

function attachment(candidate = intent()) {
  return {
    kind: candidate.kind,
    sessionId: candidate.sessionId,
    commandId: candidate.commandId,
    conversationId: `conversation-${candidate.commandId}`,
    focusId: `focus-${candidate.commandId}`,
  };
}

function createPerformanceRecorder() {
  let now = 0;
  const entries: Array<{ name: string; detail: TransitionMeasureDetail }> = [];
  const measure = vi.fn((name: string, options: PerformanceMeasureOptions) => {
    entries.push({ name, detail: options.detail as TransitionMeasureDetail });
  });
  const clearMeasures = vi.fn((name?: string) => {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (name === undefined || entries[index]?.name === name) entries.splice(index, 1);
    }
  });
  return {
    surface: {
      now: () => now,
      measure,
      clearMeasures,
      getEntriesByName: vi.fn(() => entries as unknown as PerformanceEntryList),
    },
    entries,
    measure,
    clearMeasures,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function completeConversation(
  timing: ReturnType<typeof createTransitionTimingOwner>,
  candidate: ReturnType<typeof intent>,
  source: "placeholder" | "cache" | "preview" | "snapshot" = "snapshot",
) {
  const attempt = timing.candidate(candidate);
  timing.promote(attempt);
  const attached = attachment(candidate);
  timing.attach(attached);
  timing.snapshotAccepted(attached);
  timing.present(attempt, source);
  timing.interactive(attempt, attached);
}

describe("transition timing owner", () => {
  it("settles a send-failed candidate without cancelling the active transition", () => {
    const performance = createPerformanceRecorder();
    const timing = createTransitionTimingOwner(performance.surface);
    const activeIntent = intent("workspace", "active");
    const active = timing.candidate(activeIntent);
    timing.promote(active);

    performance.advance(5);
    const rejectedIntent = intent("workspace", "rejected");
    const rejected = timing.candidate(rejectedIntent);
    timing.fail(rejected, "send-failed");
    expect(timing.isActive(active)).toBe(true);

    const attached = attachment(activeIntent);
    timing.attach(attached);
    timing.present(active, "placeholder");
    timing.interactive(active, attached);

    expect(performance.entries.map(({ detail }) => detail.termination)).toEqual([
      { kind: "failure", reason: "send-failed" },
      { kind: "success" },
    ]);
  });

  it("replaces only a promoted attempt and records first presentation once while retaining preview timing", () => {
    const performance = createPerformanceRecorder();
    const timing = createTransitionTimingOwner(performance.surface);
    const first = timing.candidate(intent("conversation", "first"));
    timing.promote(first);
    const secondIntent = intent("conversation", "second");
    const second = timing.candidate(secondIntent);
    timing.promote(second);

    performance.advance(3);
    timing.present(second, "preview");
    performance.advance(3);
    timing.present(second, "snapshot");
    const attached = attachment(secondIntent);
    timing.attach(attached);
    timing.snapshotAccepted(attached);
    timing.interactive(second, attached);

    expect(performance.entries[0]?.detail.termination).toEqual({
      kind: "cancelled",
      reason: "replacement",
    });
    expect(performance.entries[1]?.detail).toMatchObject({
      firstPresentation: { source: "preview", ms: 3 },
      previewPresentedMs: 3,
      termination: { kind: "success" },
    });
  });

  it("requires the attached snapshot identity before completing an interactive conversation", () => {
    const performance = createPerformanceRecorder();
    const timing = createTransitionTimingOwner(performance.surface);
    const candidate = intent();
    const attempt = timing.candidate(candidate);
    timing.promote(attempt);
    const attached = attachment(candidate);
    timing.attach(attached);

    timing.snapshotAccepted({ ...attached, focusId: "stale-focus" });
    timing.interactive(attempt, { ...attached, focusId: "stale-focus" });
    expect(performance.measure).not.toHaveBeenCalled();

    performance.advance(7);
    timing.snapshotAccepted(attached);
    timing.present(attempt, "snapshot");
    timing.interactive(attempt, attached);
    expect(performance.entries).toHaveLength(1);
    expect(performance.entries[0]?.detail).toMatchObject({
      snapshotAcceptedMs: 7,
      interactiveMs: 7,
      termination: { kind: "success" },
    });
  });

  it("allows an exactly attached empty workspace to become interactive without a snapshot", () => {
    const performance = createPerformanceRecorder();
    const timing = createTransitionTimingOwner(performance.surface);
    const candidate = intent("workspace");
    const attempt = timing.candidate(candidate);
    timing.promote(attempt);
    const empty = {
      kind: candidate.kind,
      sessionId: candidate.sessionId,
      commandId: candidate.commandId,
    };
    timing.attach(empty);
    timing.present(attempt, "placeholder");
    timing.interactive(attempt, { sessionId: candidate.sessionId });

    expect(performance.entries[0]?.detail).toMatchObject({
      kind: "workspace",
      firstPresentation: { source: "placeholder", ms: 0 },
      termination: { kind: "success" },
    });
    expect(performance.entries[0]?.detail).not.toHaveProperty("snapshotAcceptedMs");
  });

  it("emits sanitized versioned details through a bounded PerformanceEntry consumer surface", () => {
    const performance = createPerformanceRecorder();
    const timing = createTransitionTimingOwner(performance.surface);
    for (let index = 0; index <= MAX_RETAINED_TRANSITION_MEASURES; index++) {
      completeConversation(timing, intent("conversation", String(index)));
    }

    expect(performance.clearMeasures).toHaveBeenCalledWith(
      TRANSITION_PERFORMANCE_ENTRY_NAME,
    );
    expect(performance.entries).toHaveLength(1);
    const entry = performance.entries[0];
    expect(entry?.name).toBe(TRANSITION_PERFORMANCE_ENTRY_NAME);
    expect(entry?.detail).toEqual({
      version: 1,
      kind: "conversation",
      origin: "user",
      intentViewport: "desktop",
      cacheAtIntent: "miss",
      firstPresentation: { source: "snapshot", ms: 0 },
      attachMs: 0,
      snapshotAcceptedMs: 0,
      interactiveMs: 0,
      terminalMs: 0,
      termination: { kind: "success" },
    });
    expect(JSON.stringify(entry?.detail)).not.toContain("session-");
    expect(JSON.stringify(entry?.detail)).not.toContain("command-");
    expect(JSON.stringify(entry?.detail)).not.toContain("conversation-");
  });

  it("is a no-op when the Performance API is unavailable or incomplete", () => {
    const partialNow = vi.fn(() => 0);
    const unavailable = createTransitionTimingOwner(null);
    const incomplete = createTransitionTimingOwner({ now: partialNow });

    for (const timing of [unavailable, incomplete]) {
      const candidate = timing.candidate(intent());
      expect(() => {
        timing.promote(candidate);
        timing.attach({
          kind: "conversation",
          sessionId: "session-a",
          commandId: "command-a",
        });
        timing.present(candidate, "placeholder");
        timing.interactive(candidate, { sessionId: "session-a" });
        timing.cancel("destroyed");
      }).not.toThrow();
    }
    expect(partialNow).not.toHaveBeenCalled();
  });
});
