import { normalize, resolve } from "node:path";
import type { ToolMode } from "../shared/protocol.js";
import type { ProjectStore } from "./project-store.js";

export interface ProjectRunLease {
  release(): void;
}

interface RegisteredRun {
  readonly cancel: () => Promise<void> | void;
  readonly done: Promise<void>;
}

interface ProjectRunState {
  readonly runs: Set<RegisteredRun>;
  transitionTail: Promise<void>;
  queuedTransitions: number;
  pendingRestrictions: number;
}

function projectKey(cwd: string): string {
  const absolute = normalize(resolve(cwd));
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * Coordinates the boundary between project-wide permission changes and runs
 * owned by individual WebSocket connections.
 *
 * A read-only transition becomes restrictive synchronously, cancels every run
 * that began under the old project policy, and is only persisted/acknowledged
 * after those runs have settled.
 */
export class ProjectRunCoordinator {
  private readonly states = new Map<string, ProjectRunState>();

  isRestrictionPending(cwd: string): boolean {
    return (this.states.get(projectKey(cwd))?.pendingRestrictions ?? 0) > 0;
  }

  registerRun(
    cwd: string,
    cancel: () => Promise<void> | void,
  ): ProjectRunLease | undefined {
    const key = projectKey(cwd);
    const state = this.stateFor(key);
    if (state.pendingRestrictions > 0) {
      this.cleanUp(key, state);
      return;
    }

    let released = false;
    let resolveDone!: () => void;
    const run: RegisteredRun = {
      cancel,
      done: new Promise<void>((resolvePromise) => {
        resolveDone = resolvePromise;
      }),
    };
    state.runs.add(run);

    return {
      release: () => {
        if (released) return;
        released = true;
        state.runs.delete(run);
        resolveDone();
        this.cleanUp(key, state);
      },
    };
  }

  transitionToolMode(
    project: Pick<ProjectStore, "cwd" | "setToolMode">,
    mode: ToolMode,
  ): Promise<void> {
    const key = projectKey(project.cwd);
    const state = this.stateFor(key);
    let runsToSettle: RegisteredRun[] = [];

    if (mode === "read_only") {
      state.pendingRestrictions++;
      runsToSettle = [...state.runs];
      for (const run of runsToSettle) {
        try {
          void Promise.resolve(run.cancel()).catch(() => undefined);
        } catch {
          // Settlement remains authoritative: the mode is not acknowledged
          // until the owning connection releases its run lease.
        }
      }
    }

    state.queuedTransitions++;
    const transition = state.transitionTail
      .catch(() => undefined)
      .then(async () => {
        try {
          if (mode === "read_only") {
            await Promise.all(runsToSettle.map((run) => run.done));
          }
          await project.setToolMode(mode);
        } finally {
          if (mode === "read_only") state.pendingRestrictions--;
        }
      });
    state.transitionTail = transition;

    return transition.finally(() => {
      state.queuedTransitions--;
      this.cleanUp(key, state);
    });
  }

  private stateFor(key: string): ProjectRunState {
    let state = this.states.get(key);
    if (!state) {
      state = {
        runs: new Set(),
        transitionTail: Promise.resolve(),
        queuedTransitions: 0,
        pendingRestrictions: 0,
      };
      this.states.set(key, state);
    }
    return state;
  }

  private cleanUp(key: string, state: ProjectRunState): void {
    if (
      state.runs.size === 0
      && state.queuedTransitions === 0
      && state.pendingRestrictions === 0
      && this.states.get(key) === state
    ) {
      this.states.delete(key);
    }
  }
}
