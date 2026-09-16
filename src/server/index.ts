import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CustomProviderStore } from "./custom-provider-store.js";
import { refreshModelCatalogOnStartup } from "./model-refresh.js";
import { PiRuntime } from "./pi-runtime.js";
import { attachSocketServer } from "./socket-server.js";
import { UiPreferencesStore } from "./ui-preferences-store.js";
import type {
  ReloadConversationTarget,
  ReloadTargetCompletion,
} from "./project-session-coordinator.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 31415);
const app = express();
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist-client");

app.disable("x-powered-by");
app.get("/health", (_request, response) => response.json({ ok: true }));
app.use(express.static(clientDir, { index: false }));
app.get("/{*path}", (_request, response) => response.sendFile(
  resolve(clientDir, "index.html"),
  { dotfiles: "allow" },
));

const runtime = await PiRuntime.create({ allowModelNetwork: false });
const uiPreferences = await UiPreferencesStore.open();
if (uiPreferences.getLoadWarning()) {
  console.warn(uiPreferences.getLoadWarning());
}
const server = app.listen(port, host, () => {
  console.log(`Pi Web: http://${host}:${port}`);
  process.send?.({ type: "piweb_ready" });
});

const socketServer = attachSocketServer(
  server,
  process.cwd(),
  runtime,
  undefined,
  process.send !== undefined,
  uiPreferences,
  // models.json 是 Pi 自己的用户级配置：与 pi CLI 共享同一份真相，
  // 已注册为内置 provider 的 id 只投影为不可表单编辑。
  new CustomProviderStore({
    modelsPath: join(getAgentDir(), "models.json"),
    builtinProviderIds: new Set(builtinProviders().map((provider) => provider.id)),
  }),
);
const startupAbortController = new AbortController();
const startupModelRefresh = refreshModelCatalogOnStartup(
  runtime,
  startupAbortController.signal,
  (error) => {
    console.warn(
      "Automatic model refresh failed",
      error instanceof Error ? error.message : "unknown error",
    );
  },
);

let shutdownPromise: Promise<void> | undefined;

interface ReloadCompletionWaiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface BufferedReloadCompletion {
  readonly completion: ReloadTargetCompletion;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const reloadCompletionWaiters = new Map<string, ReloadCompletionWaiter>();
const reloadResumeAppliedWaiters = new Map<string, ReloadCompletionWaiter>();
let reloadResumeProcessing = Promise.resolve();

function closeHttpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function shutdown(): void {
  shutdownPromise ??= (async () => {
    startupAbortController.abort();
    await startupModelRefresh;
    await Promise.all([
      closeHttpServer(),
      socketServer.close(),
    ]);
  })().then(
    () => {
      process.exitCode = 0;
      if (process.connected) process.disconnect();
    },
    (error) => {
      console.error("Failed to shut down cleanly", error);
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    },
  );
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", () => {
  const error = new Error("Supervisor disconnected before reload completion acknowledgement");
  for (const waiter of reloadCompletionWaiters.values()) waiter.reject(error);
  reloadCompletionWaiters.clear();
  for (const waiter of reloadResumeAppliedWaiters.values()) waiter.reject(error);
  reloadResumeAppliedWaiters.clear();
  shutdown();
  const forcedExit = setTimeout(() => process.exit(1), 5_000);
  forcedExit.unref();
});

function isReloadTarget(value: unknown): value is ReloadConversationTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return typeof target.cwd === "string"
    && typeof target.conversationId === "string"
    && typeof target.continueTask === "boolean"
    && (target.continueTask
      ? typeof target.continuationRunId === "string"
      : target.continuationRunId === undefined)
    && (
      target.adoptedRunId === undefined
      || typeof target.adoptedRunId === "string"
    );
}

function reloadCompletionKey(completion: ReloadTargetCompletion): string {
  return JSON.stringify([
    completion.requestId,
    completion.cwd,
    completion.conversationId,
    completion.runId,
  ]);
}

function reloadResumeAppliedKey(requestId: string, resumeId: string): string {
  return JSON.stringify([requestId, resumeId]);
}

function registerReloadResumeApplied(
  requestId: string,
  resumeId: string,
): ReloadCompletionWaiter {
  const key = reloadResumeAppliedKey(requestId, resumeId);
  if (reloadResumeAppliedWaiters.has(key)) {
    throw new Error("Reload reconciliation already awaits a durable disposition acknowledgement");
  }
  let resolveWaiter!: () => void;
  let rejectWaiter!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveWaiter = resolve;
    rejectWaiter = reject;
  });
  void promise.catch(() => undefined);
  const waiter = {
    promise,
    resolve: resolveWaiter,
    reject: rejectWaiter,
  };
  reloadResumeAppliedWaiters.set(key, waiter);
  return waiter;
}

function sendReloadTargetCompletion(
  completion: ReloadTargetCompletion,
): Promise<void> {
  const key = reloadCompletionKey(completion);
  const existing = reloadCompletionWaiters.get(key);
  if (existing) return existing.promise;

  let resolveWaiter!: () => void;
  let rejectWaiter!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveWaiter = resolve;
    rejectWaiter = reject;
  });
  const waiter = {
    promise,
    resolve: resolveWaiter,
    reject: rejectWaiter,
  };
  reloadCompletionWaiters.set(key, waiter);
  void sendToSupervisor({
    type: "piweb_reload_target_completed",
    ...completion,
  }).catch((error: unknown) => {
    if (reloadCompletionWaiters.get(key) === waiter) {
      reloadCompletionWaiters.delete(key);
      waiter.reject(error);
    }
  });
  return promise;
}

function sendToSupervisor(message: object): Promise<void> {
  return new Promise((resolveSend, rejectSend) => {
    if (!process.send) {
      rejectSend(new Error("Pi Web server is not supervised"));
      return;
    }
    process.send(message, (error) => error ? rejectSend(error) : resolveSend());
  });
}

process.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null) return;
  const record = message as Record<string, unknown>;
  if (record.type === "piweb_reload_reconciliation_complete") {
    socketServer.releaseStartupAdmission();
    return;
  }
  if (
    record.type === "piweb_reload_resumed_applied"
    && typeof record.requestId === "string"
    && typeof record.resumeId === "string"
  ) {
    const key = reloadResumeAppliedKey(record.requestId, record.resumeId);
    const waiter = reloadResumeAppliedWaiters.get(key);
    if (!waiter) return;
    reloadResumeAppliedWaiters.delete(key);
    waiter.resolve();
    return;
  }
  if (
    (
      record.type === "piweb_reload_target_completion_ack"
      || record.type === "piweb_reload_target_completion_rejected"
    )
    && typeof record.requestId === "string"
    && typeof record.cwd === "string"
    && typeof record.conversationId === "string"
    && typeof record.runId === "string"
  ) {
    const completion = {
      requestId: record.requestId,
      cwd: record.cwd,
      conversationId: record.conversationId,
      runId: record.runId,
    };
    const key = reloadCompletionKey(completion);
    const waiter = reloadCompletionWaiters.get(key);
    if (!waiter) return;
    if (record.type === "piweb_reload_target_completion_ack") {
      reloadCompletionWaiters.delete(key);
      waiter.resolve();
    } else {
      reloadCompletionWaiters.delete(key);
      waiter.reject(new Error(
        "Supervisor rejected stale reload target completion identity",
      ));
    }
    return;
  }
  if (
    record.type === "piweb_prepare_reload"
    && typeof record.requestId === "string"
    && typeof record.force === "boolean"
  ) {
    const requestId = record.requestId;
    void (async () => {
      startupAbortController.abort();
      let markAdmissionFrozen!: () => void;
      const admissionFrozen = new Promise<void>((resolveFrozen) => {
        markAdmissionFrozen = resolveFrozen;
      });
      const targetsPromise = socketServer.prepareReload(
        record.force === true,
        markAdmissionFrozen,
      );
      void targetsPromise.catch(() => undefined);
      await Promise.race([
        admissionFrozen,
        targetsPromise.then(
          () => {
            throw new Error(
              "Reload preparation completed without freezing admission",
            );
          },
          (error) => { throw error; },
        ),
      ]);
      await sendToSupervisor({
        type: "piweb_reload_accepted",
        requestId,
      });
      await startupModelRefresh;
      const targets = await targetsPromise;
      await sendToSupervisor({
        type: "piweb_reload_ready",
        requestId,
        targets,
      });
      process.exit(0);
    })().catch(async (error) => {
      console.error("Failed to prepare hot reload", error);
      await sendToSupervisor({
        type: "piweb_reload_failed",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    });
    return;
  }
  if (
    record.type === "piweb_resume_reload"
    && typeof record.requestId === "string"
    && typeof record.resumeId === "string"
    && Array.isArray(record.targets)
    && record.targets.every(isReloadTarget)
  ) {
    const requestId = record.requestId;
    const resumeId = record.resumeId;
    const targets = record.targets;
    const bufferedCompletions: BufferedReloadCompletion[] = [];
    let completionPhase: "pending" | "flushing" | "reported" | "failed" =
      "pending";
    const onTargetCompleted = (
      completion: ReloadTargetCompletion,
    ): Promise<void> => {
      if (completionPhase === "reported") {
        return sendReloadTargetCompletion(completion);
      }
      if (completionPhase === "failed") {
        return Promise.reject(new Error("Reload reconciliation failed"));
      }
      return new Promise<void>((resolve, reject) => {
        bufferedCompletions.push({ completion, resolve, reject });
      });
    };

    let appliedWaiter: ReloadCompletionWaiter | undefined;
    reloadResumeProcessing = reloadResumeProcessing.then(async () => {
      try {
        const dispositions = await socketServer.resumeAfterReload(
          requestId,
          targets,
          onTargetCompleted,
        );
        appliedWaiter = registerReloadResumeApplied(requestId, resumeId);
        await sendToSupervisor({
          type: "piweb_reload_resumed",
          requestId,
          resumeId,
          dispositions,
        });
        await appliedWaiter.promise;
        await socketServer.acknowledgeReloadDispositions(
          requestId,
          dispositions,
        );
        socketServer.releaseStartupAdmission();
        completionPhase = "flushing";
        while (bufferedCompletions.length > 0) {
          const buffered = bufferedCompletions.shift()!;
          try {
            await sendReloadTargetCompletion(buffered.completion);
            buffered.resolve();
          } catch (error) {
            buffered.reject(error);
            throw error;
          }
        }
        completionPhase = "reported";
      } catch (error) {
        if (
          appliedWaiter !== undefined
          && reloadResumeAppliedWaiters.get(
            reloadResumeAppliedKey(requestId, resumeId),
          ) === appliedWaiter
        ) {
          reloadResumeAppliedWaiters.delete(
            reloadResumeAppliedKey(requestId, resumeId),
          );
          appliedWaiter.reject(error);
        }
        completionPhase = "failed";
        for (const buffered of bufferedCompletions.splice(0)) {
          buffered.reject(error);
        }
        await sendToSupervisor({
          type: "piweb_reload_failed",
          requestId,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    void reloadResumeProcessing.catch((error) => {
      console.error("Failed to report hot reload recovery", error);
    });
  }
});
