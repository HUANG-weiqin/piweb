export type ClientTransitionKind = "workspace" | "conversation";
export type TransitionOrigin = "user" | "restore" | "reconnect";
export type TransitionCacheAtIntent = "hit" | "miss" | "n/a";
export type TransitionPresentationSource = "placeholder" | "cache" | "preview" | "snapshot";
export type TransitionCancellation = "replacement" | "disconnect" | "destroyed" | "protocol-error";

export interface ClientTransitionIntent {
  kind: ClientTransitionKind;
  sessionId: string;
  commandId: string;
  origin: TransitionOrigin;
  intentViewport: "desktop" | "mobile";
  cacheAtIntent: TransitionCacheAtIntent;
}

export interface ClientTransitionAttachment {
  kind: ClientTransitionKind;
  sessionId: string;
  commandId: string;
  conversationId?: string;
  focusId?: string;
}

export interface ClientTransitionObservation {
  sessionId: string;
  conversationId?: string;
  focusId?: string;
}

export interface TransitionMeasureDetail {
  version: 1;
  kind: ClientTransitionKind;
  origin: TransitionOrigin;
  intentViewport: "desktop" | "mobile";
  cacheAtIntent: TransitionCacheAtIntent;
  firstPresentation?: {
    source: TransitionPresentationSource;
    ms: number;
  };
  previewPresentedMs?: number;
  attachMs?: number;
  snapshotAcceptedMs?: number;
  interactiveMs?: number;
  terminalMs: number;
  termination:
    | { kind: "success" }
    | { kind: "failure"; reason: "send-failed" | "server-error" }
    | { kind: "cancelled"; reason: TransitionCancellation };
}

export interface TransitionTimingAttempt {
  readonly token: symbol;
}

interface TransitionPerformanceSurface {
  now(): number;
  measure(name: string, options: PerformanceMeasureOptions): unknown;
  clearMeasures(name?: string): void;
  getEntriesByName(name: string, type?: string): PerformanceEntryList;
}

interface ActiveTransition {
  attempt: TransitionTimingAttempt;
  intent: ClientTransitionIntent;
  intentMs: number;
  attachment?: ClientTransitionAttachment;
  detail: Omit<TransitionMeasureDetail, "terminalMs" | "termination">;
}

export const TRANSITION_PERFORMANCE_ENTRY_NAME = "piweb.transition";
export const MAX_RETAINED_TRANSITION_MEASURES = 100;

export interface TransitionTimingOwner {
  candidate(intent: ClientTransitionIntent): TransitionTimingAttempt;
  promote(attempt: TransitionTimingAttempt): boolean;
  fail(attempt: TransitionTimingAttempt, reason: "send-failed"): void;
  failMatching(intent: Pick<ClientTransitionIntent, "kind" | "sessionId" | "commandId">, reason: "server-error"): void;
  attemptFor(intent: Pick<ClientTransitionIntent, "kind" | "sessionId" | "commandId">): TransitionTimingAttempt | undefined;
  attach(attachment: ClientTransitionAttachment): TransitionTimingAttempt | undefined;
  snapshotAccepted(observation: ClientTransitionObservation): TransitionTimingAttempt | undefined;
  present(attempt: TransitionTimingAttempt, source: TransitionPresentationSource): void;
  interactive(attempt: TransitionTimingAttempt, observation: ClientTransitionObservation): void;
  cancel(reason: TransitionCancellation, intent?: Pick<ClientTransitionIntent, "kind" | "sessionId" | "commandId">): void;
  isActive(attempt: TransitionTimingAttempt): boolean;
}

function supportsTransitionTiming(
  surface: Partial<TransitionPerformanceSurface> | null,
): surface is TransitionPerformanceSurface {
  return surface !== null
    && typeof surface.now === "function"
    && typeof surface.measure === "function"
    && typeof surface.clearMeasures === "function"
    && typeof surface.getEntriesByName === "function";
}

class PerformanceTransitionTimingOwner implements TransitionTimingOwner {
  private active?: ActiveTransition;
  private readonly candidates = new Set<ActiveTransition>();

  constructor(private readonly performance?: TransitionPerformanceSurface) {}

  candidate(intent: ClientTransitionIntent): TransitionTimingAttempt {
    const attempt: TransitionTimingAttempt = { token: Symbol("transition") };
    const active: ActiveTransition = {
      attempt,
      intent,
      intentMs: this.now(),
      detail: {
        version: 1,
        kind: intent.kind,
        origin: intent.origin,
        intentViewport: intent.intentViewport,
        cacheAtIntent: intent.cacheAtIntent,
      },
    };
    this.candidates.add(active);
    return attempt;
  }

  promote(attempt: TransitionTimingAttempt): boolean {
    const candidate = this.findCandidate(attempt);
    if (!candidate) return false;
    if (this.active) this.terminal(this.active, { kind: "cancelled", reason: "replacement" });
    this.candidates.delete(candidate);
    this.active = candidate;
    return true;
  }

  fail(attempt: TransitionTimingAttempt, reason: "send-failed"): void {
    const candidate = this.findCandidate(attempt);
    if (candidate) {
      this.candidates.delete(candidate);
      this.terminal(candidate, { kind: "failure", reason });
      return;
    }
    if (this.active?.attempt === attempt) {
      this.terminal(this.active, { kind: "failure", reason });
    }
  }

  failMatching(
    intent: Pick<ClientTransitionIntent, "kind" | "sessionId" | "commandId">,
    reason: "server-error",
  ): void {
    if (this.active && this.matchesIntent(this.active, intent)) {
      this.terminal(this.active, { kind: "failure", reason });
    }
  }

  attemptFor(
    intent: Pick<ClientTransitionIntent, "kind" | "sessionId" | "commandId">,
  ): TransitionTimingAttempt | undefined {
    return this.active && this.matchesIntent(this.active, intent)
      ? this.active.attempt
      : undefined;
  }

  attach(attachment: ClientTransitionAttachment): TransitionTimingAttempt | undefined {
    const active = this.active;
    if (!active || active.attachment || !this.matchesIntent(active, attachment)) return undefined;
    active.attachment = attachment;
    active.detail.attachMs = this.elapsed(active);
    return active.attempt;
  }

  snapshotAccepted(observation: ClientTransitionObservation): TransitionTimingAttempt | undefined {
    const active = this.active;
    if (!active || !this.matchesObservation(active, observation)) return undefined;
    if (active.detail.snapshotAcceptedMs === undefined) {
      active.detail.snapshotAcceptedMs = this.elapsed(active);
    }
    return active.attempt;
  }

  present(attempt: TransitionTimingAttempt, source: TransitionPresentationSource): void {
    const active = this.active;
    if (!active || active.attempt !== attempt) return;
    const elapsed = this.elapsed(active);
    if (active.detail.firstPresentation === undefined) {
      active.detail.firstPresentation = { source, ms: elapsed };
    }
    if (source === "preview" && active.detail.previewPresentedMs === undefined) {
      active.detail.previewPresentedMs = elapsed;
    }
  }

  interactive(attempt: TransitionTimingAttempt, observation: ClientTransitionObservation): void {
    const active = this.active;
    if (
      !active
      || active.attempt !== attempt
      || !this.matchesObservation(active, observation)
      || active.detail.interactiveMs !== undefined
    ) return;
    active.detail.interactiveMs = this.elapsed(active);
    this.terminal(active, { kind: "success" });
  }

  cancel(
    reason: TransitionCancellation,
    intent?: Pick<ClientTransitionIntent, "kind" | "sessionId" | "commandId">,
  ): void {
    if (!this.active || (intent && !this.matchesIntent(this.active, intent))) return;
    this.terminal(this.active, { kind: "cancelled", reason });
  }

  isActive(attempt: TransitionTimingAttempt): boolean {
    return this.active?.attempt === attempt;
  }

  private findCandidate(attempt: TransitionTimingAttempt): ActiveTransition | undefined {
    return [...this.candidates].find((candidate) => candidate.attempt === attempt);
  }

  private matchesIntent(
    active: ActiveTransition,
    intent: Pick<ClientTransitionIntent, "kind" | "sessionId" | "commandId">,
  ): boolean {
    return active.intent.kind === intent.kind
      && active.intent.sessionId === intent.sessionId
      && active.intent.commandId === intent.commandId;
  }

  private matchesObservation(
    active: ActiveTransition,
    observation: ClientTransitionObservation,
  ): boolean {
    return active.attachment !== undefined
      && active.attachment.sessionId === observation.sessionId
      && active.attachment.conversationId === observation.conversationId
      && active.attachment.focusId === observation.focusId;
  }

  private terminal(
    active: ActiveTransition,
    termination: TransitionMeasureDetail["termination"],
  ): void {
    this.candidates.delete(active);
    if (this.active === active) this.active = undefined;
    const terminalMs = this.elapsed(active);
    const detail: TransitionMeasureDetail = {
      ...active.detail,
      terminalMs,
      termination,
    };
    this.attempt(() => {
      const entries = this.performance?.getEntriesByName(
        TRANSITION_PERFORMANCE_ENTRY_NAME,
        "measure",
      ) ?? [];
      if (entries.length >= MAX_RETAINED_TRANSITION_MEASURES) {
        this.performance?.clearMeasures(TRANSITION_PERFORMANCE_ENTRY_NAME);
      }
      this.performance?.measure(TRANSITION_PERFORMANCE_ENTRY_NAME, {
        start: active.intentMs,
        duration: terminalMs,
        detail,
      });
    });
  }

  private elapsed(active: ActiveTransition): number {
    return Math.max(0, this.now() - active.intentMs);
  }

  private now(): number {
    try {
      return this.performance?.now() ?? 0;
    } catch {
      return 0;
    }
  }

  private attempt(operation: () => unknown): void {
    try {
      operation();
    } catch {
      // Observability must not change a client transition's control flow.
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
