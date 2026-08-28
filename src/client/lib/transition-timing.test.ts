import { describe, expect, it, vi } from "vitest";
import { createTransitionTimingOwner } from "./transition-timing";

const MEASURES = {
  workspace: {
    attach: "piweb.workspace.intent-to-attach",
    ready: "piweb.workspace.intent-to-ready",
  },
  conversation: {
    attach: "piweb.conversation.intent-to-attach",
    ready: "piweb.conversation.intent-to-ready",
  },
} as const;

function createPerformanceRecorder() {
  const mark = vi.fn();
  const measure = vi.fn();
  const clearMarks = vi.fn();
  return {
    surface: { mark, measure, clearMarks },
    mark,
    measure,
    clearMarks,
  };
}

describe("transition timing owner", () => {
  it("measures one workspace intent-to-attach and intent-to-ready", () => {
    const performance = createPerformanceRecorder();
    const timing = createTransitionTimingOwner(performance.surface);
    const intent = {
      kind: "workspace" as const,
      sessionId: "session-a",
      commandId: "command-a",
    };
    const attached = {
      ...intent,
      conversationId: "conversation-a",
      focusId: "focus-a",
    };

    timing.begin(intent);
    timing.attach(attached);
    timing.attach(attached);
    timing.ready({
      sessionId: intent.sessionId,
      conversationId: attached.conversationId,
      focusId: attached.focusId,
    });
    timing.ready({
      sessionId: intent.sessionId,
      conversationId: attached.conversationId,
      focusId: attached.focusId,
    });

    const intentMark = performance.mark.mock.calls[0]?.[0];
    const attachMark = performance.mark.mock.calls[1]?.[0];
    const readyMark = performance.mark.mock.calls[2]?.[0];
    expect(performance.measure).toHaveBeenCalledTimes(2);
    expect(performance.measure).toHaveBeenNthCalledWith(
      1,
      MEASURES.workspace.attach,
      intentMark,
      attachMark,
    );
    expect(performance.measure).toHaveBeenNthCalledWith(
      2,
      MEASURES.workspace.ready,
      intentMark,
      readyMark,
    );
    expect(performance.clearMarks).toHaveBeenCalledWith(intentMark);
    expect(performance.clearMarks).toHaveBeenCalledWith(attachMark);
    expect(performance.clearMarks).toHaveBeenCalledWith(readyMark);
  });

  it("clears replacement and failure marks without settling stale identities", () => {
    const performance = createPerformanceRecorder();
    const timing = createTransitionTimingOwner(performance.surface);
    const replaced = {
      kind: "workspace" as const,
      sessionId: "session-old",
      commandId: "command-old",
    };
    const current = {
      kind: "conversation" as const,
      sessionId: "session-current",
      commandId: "command-current",
    };

    timing.begin(replaced);
    const replacedIntentMark = performance.mark.mock.calls.at(-1)?.[0];
    timing.begin(current);
    const currentIntentMark = performance.mark.mock.calls.at(-1)?.[0];

    expect(performance.clearMarks).toHaveBeenCalledWith(replacedIntentMark);
    timing.attach({
      ...replaced,
      conversationId: "conversation-old",
      focusId: "focus-old",
    });
    timing.cancel(replaced);
    expect(performance.measure).not.toHaveBeenCalled();

    timing.attach({
      ...current,
      conversationId: "conversation-current",
      focusId: "focus-current",
    });
    timing.ready({
      sessionId: replaced.sessionId,
      conversationId: "conversation-old",
      focusId: "focus-old",
    });
    timing.cancel({ ...current, commandId: "stale-command" });
    timing.ready({
      sessionId: current.sessionId,
      conversationId: "conversation-current",
      focusId: "focus-current",
    });
    expect(performance.measure).toHaveBeenCalledWith(
      MEASURES.conversation.attach,
      currentIntentMark,
      expect.any(String),
    );
    expect(performance.measure).toHaveBeenCalledWith(
      MEASURES.conversation.ready,
      currentIntentMark,
      expect.any(String),
    );

    const failed = {
      kind: "conversation" as const,
      sessionId: "session-failed",
      commandId: "command-failed",
    };
    timing.begin(failed);
    const failedIntentMark = performance.mark.mock.calls.at(-1)?.[0];
    timing.cancel(failed);
    expect(performance.clearMarks).toHaveBeenCalledWith(failedIntentMark);
    expect(performance.measure).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when the Performance API is unavailable or incomplete", () => {
    const partialMark = vi.fn();
    const unavailable = createTransitionTimingOwner(null);
    const incomplete = createTransitionTimingOwner({ mark: partialMark });
    const intent = {
      kind: "workspace" as const,
      sessionId: "session-a",
      commandId: "command-a",
    };

    for (const timing of [unavailable, incomplete]) {
      expect(() => {
        timing.begin(intent);
        timing.attach(intent);
        timing.ready({ sessionId: intent.sessionId });
        timing.cancel();
      }).not.toThrow();
    }
    expect(partialMark).not.toHaveBeenCalled();
  });
});
