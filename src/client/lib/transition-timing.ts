type ClientTransitionKind = "workspace" | "conversation";

interface ClientTransitionIntent {
  kind: ClientTransitionKind;
  sessionId: string;
  commandId: string;
}

interface ClientTransitionAttachment extends ClientTransitionIntent {
  conversationId?: string;
  focusId?: string;
}

interface ClientTransitionObservation {
  sessionId: string;
  conversationId?: string;
  focusId?: string;
}

interface TransitionPerformanceSurface {
  mark(name: string): unknown;
  measure(name: string, startMark: string, endMark: string): unknown;
  clearMarks(name?: string): void;
}

const TRANSITION_MEASURE_NAMES = {
  workspace: {
    attach: "piweb.workspace.intent-to-attach",
    ready: "piweb.workspace.intent-to-ready",
  },
  conversation: {
    attach: "piweb.conversation.intent-to-attach",
    ready: "piweb.conversation.intent-to-ready",
  },
} as const;

interface TransitionTimingOwner {
  begin(intent: ClientTransitionIntent): void;
  attach(attachment: ClientTransitionAttachment): void;
  ready(observation: ClientTransitionObservation): void;
  cancel(intent?: ClientTransitionIntent): void;
}

interface ActiveTransition extends ClientTransitionIntent {
  marks: {
    intent: string;
    attach: string;
    ready: string;
  };
  attachment?: {
    conversationId?: string;
    focusId?: string;
  };
}

function supportsTransitionTiming(
  surface: Partial<TransitionPerformanceSurface> | null,
): surface is TransitionPerformanceSurface {
  return surface !== null
    && typeof surface.mark === "function"
    && typeof surface.measure === "function"
    && typeof surface.clearMarks === "function";
}

function marksFor(intent: ClientTransitionIntent): ActiveTransition["marks"] {
  const prefix = [
    "piweb.transition",
    intent.kind,
    intent.sessionId,
    intent.commandId,
  ].join(".");
  return {
    intent: `${prefix}.intent`,
    attach: `${prefix}.attach`,
    ready: `${prefix}.ready`,
  };
}

class PerformanceTransitionTimingOwner implements TransitionTimingOwner {
  private active?: ActiveTransition;

  constructor(private readonly performance?: TransitionPerformanceSurface) {}

  begin(intent: ClientTransitionIntent): void {
    this.cancel();
    const active: ActiveTransition = {
      ...intent,
      marks: marksFor(intent),
    };
    this.active = active;
    this.mark(active.marks.intent);
  }

  attach(attachment: ClientTransitionAttachment): void {
    const active = this.active;
    if (
      !active
      || active.attachment !== undefined
      || !this.matchesIntent(active, attachment)
    ) return;
    active.attachment = {
      conversationId: attachment.conversationId,
      focusId: attachment.focusId,
    };
    this.measure(
      TRANSITION_MEASURE_NAMES[active.kind].attach,
      active.marks.intent,
      active.marks.attach,
    );
  }

  ready(observation: ClientTransitionObservation): void {
    const active = this.active;
    if (
      !active?.attachment
      || active.sessionId !== observation.sessionId
      || active.attachment.conversationId !== observation.conversationId
      || active.attachment.focusId !== observation.focusId
    ) return;
    this.measure(
      TRANSITION_MEASURE_NAMES[active.kind].ready,
      active.marks.intent,
      active.marks.ready,
    );
    this.clearMark(active.marks.intent);
    this.active = undefined;
  }

  cancel(intent?: ClientTransitionIntent): void {
    const active = this.active;
    if (!active || (intent && !this.matchesIntent(active, intent))) return;
    this.clearMark(active.marks.intent);
    this.clearMark(active.marks.attach);
    this.clearMark(active.marks.ready);
    this.active = undefined;
  }

  private matchesIntent(
    active: ActiveTransition,
    intent: ClientTransitionIntent,
  ): boolean {
    return active.kind === intent.kind
      && active.sessionId === intent.sessionId
      && active.commandId === intent.commandId;
  }

  private mark(name: string): void {
    this.attempt(() => this.performance?.mark(name));
  }

  private measure(name: string, startMark: string, endMark: string): void {
    this.attempt(() => {
      this.performance?.mark(endMark);
      this.performance?.measure(name, startMark, endMark);
    });
    this.clearMark(endMark);
  }

  private clearMark(name: string): void {
    this.attempt(() => this.performance?.clearMarks(name));
  }

  private attempt(operation: () => unknown): void {
    try {
      operation();
    } catch {
      // Timing probes must never affect the transition they observe.
    }
  }
}

export function createTransitionTimingOwner(
  surface: Partial<TransitionPerformanceSurface> | null =
    typeof globalThis.performance === "undefined"
      ? null
      : globalThis.performance,
): TransitionTimingOwner {
  return new PerformanceTransitionTimingOwner(
    supportsTransitionTiming(surface) ? surface : undefined,
  );
}
