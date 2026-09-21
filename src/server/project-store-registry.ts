import { isAbsolute, resolve } from "node:path";
import {
  ProjectStore,
  assertSessionId,
  canonicalDirectory,
  pathIdentity,
} from "./project-store.js";

const DEFAULT_CONVERSATION_LEASE_TIMEOUT_MS = 5_000;

export interface ConversationLease {
  release(): void;
  upgradeToDeletion(): ConversationDeletionLease;
}

export interface ConversationDeletionLease {
  release(): void;
}

export interface ProjectStoreHandle {
  readonly store: ProjectStore;
  release(): void;
}

export interface ConversationLeaseWaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ProjectStoreRegistryEntry {
  opening: Promise<ProjectStore>;
  references: number;
}

interface ConversationLeaseWaiter {
  token: symbol;
  resolve(lease: ConversationLease): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface ConversationLeaseState {
  owner: symbol;
  waiters: ConversationLeaseWaiter[];
}

export class ProjectStoreRegistry {
  private readonly stores = new Map<string, ProjectStoreRegistryEntry>();
  private readonly leases = new Map<string, ConversationLeaseState>();

  async acquireProject(cwd: string): Promise<ProjectStoreHandle> {
    const canonicalCwd = await canonicalDirectory(cwd);
    const key = pathIdentity(canonicalCwd);
    const entry = this.getOrCreateProjectEntry(key, canonicalCwd);
    entry.references += 1;

    let store: ProjectStore;
    try {
      store = await entry.opening;
    } catch (error) {
      entry.references -= 1;
      this.deleteProjectEntry(key, entry);
      throw error;
    }

    let released = false;
    return {
      store,
      release: () => {
        if (released) return;
        released = true;
        entry.references -= 1;
        if (entry.references === 0) {
          this.deleteProjectEntry(key, entry);
        }
      },
    };
  }

  acquireConversation(
    canonicalCwd: string,
    conversationId: string,
  ): ConversationLease {
    const key = this.conversationLeaseKey(canonicalCwd, conversationId);
    if (this.leases.has(key)) {
      throw new Error(
        `Conversation ${conversationId} in project ${resolve(canonicalCwd)} is already leased`,
      );
    }

    const token = Symbol(key);
    const state: ConversationLeaseState = {
      owner: token,
      waiters: [],
    };
    this.leases.set(key, state);
    return this.createConversationLease(key, state, token);
  }

  acquireConversationWhenAvailable(
    canonicalCwd: string,
    conversationId: string,
    options: ConversationLeaseWaitOptions = {},
  ): Promise<ConversationLease> {
    const key = this.conversationLeaseKey(canonicalCwd, conversationId);
    const timeoutMs =
      options.timeoutMs ?? DEFAULT_CONVERSATION_LEASE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("timeoutMs must be a finite non-negative number");
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.createAbortError());
    }

    const current = this.leases.get(key);
    if (current === undefined) {
      return Promise.resolve(
        this.acquireConversation(canonicalCwd, conversationId),
      );
    }

    return new Promise<ConversationLease>((resolveLease, rejectLease) => {
      const waiter: ConversationLeaseWaiter = {
        token: Symbol(key),
        resolve: resolveLease,
        reject: rejectLease,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        settled: false,
      };

      if (options.signal !== undefined) {
        waiter.abortListener = () => {
          this.cancelConversationWaiter(
            key,
            current,
            waiter,
            this.createAbortError(),
          );
        };
        options.signal.addEventListener("abort", waiter.abortListener, {
          once: true,
        });
      }
      waiter.timer = setTimeout(() => {
        this.cancelConversationWaiter(
          key,
          current,
          waiter,
          new Error(
            `Timed out waiting for conversation ${conversationId} in project ${resolve(canonicalCwd)}`,
          ),
        );
      }, timeoutMs);
      current.waiters.push(waiter);
    });
  }

  private getOrCreateProjectEntry(
    key: string,
    canonicalCwd: string,
  ): ProjectStoreRegistryEntry {
    const existing = this.stores.get(key);
    if (existing !== undefined) return existing;

    const entry: ProjectStoreRegistryEntry = {
      opening: ProjectStore.open(canonicalCwd),
      references: 0,
    };
    this.stores.set(key, entry);
    return entry;
  }

  private deleteProjectEntry(
    key: string,
    entry: ProjectStoreRegistryEntry,
  ): void {
    if (this.stores.get(key) === entry) {
      this.stores.delete(key);
    }
  }

  private conversationLeaseKey(
    canonicalCwd: string,
    conversationId: string,
  ): string {
    if (typeof canonicalCwd !== "string" || !isAbsolute(canonicalCwd)) {
      throw new Error("canonicalCwd must be an absolute path");
    }
    assertSessionId(conversationId, "conversationId");
    const cwdKey = pathIdentity(canonicalCwd);
    return `${cwdKey.length}:${cwdKey}:${conversationId}`;
  }

  private createConversationLease(
    key: string,
    state: ConversationLeaseState,
    token: symbol,
  ): ConversationLease {
    let released = false;
    let upgraded = false;
    return {
      release: () => {
        if (released || upgraded) return;
        released = true;
        this.releaseConversationLease(key, state, token);
      },
      upgradeToDeletion: () => {
        if (released || upgraded) {
          throw new Error("Conversation lease is no longer owned");
        }
        if (this.leases.get(key) !== state || state.owner !== token) {
          throw new Error("Conversation lease ownership changed");
        }
        upgraded = true;
        return this.createConversationDeletionLease(key, state, token);
      },
    };
  }

  private createConversationDeletionLease(
    key: string,
    state: ConversationLeaseState,
    token: symbol,
  ): ConversationDeletionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseConversationLease(key, state, token);
      },
    };
  }

  private releaseConversationLease(
    key: string,
    state: ConversationLeaseState,
    token: symbol,
  ): void {
    if (this.leases.get(key) !== state || state.owner !== token) return;

    const waiter = state.waiters.shift();
    if (waiter === undefined) {
      this.leases.delete(key);
      return;
    }

    state.owner = waiter.token;
    this.settleConversationWaiter(waiter);
    waiter.resolve(
      this.createConversationLease(key, state, waiter.token),
    );
  }

  private cancelConversationWaiter(
    key: string,
    state: ConversationLeaseState,
    waiter: ConversationLeaseWaiter,
    error: Error,
  ): void {
    if (waiter.settled || this.leases.get(key) !== state) return;
    const index = state.waiters.indexOf(waiter);
    if (index === -1) return;
    state.waiters.splice(index, 1);
    this.settleConversationWaiter(waiter);
    waiter.reject(error);
  }

  private settleConversationWaiter(waiter: ConversationLeaseWaiter): void {
    waiter.settled = true;
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
  }

  private createAbortError(): Error {
    const error = new Error("Conversation lease wait was aborted");
    error.name = "AbortError";
    return error;
  }
}
