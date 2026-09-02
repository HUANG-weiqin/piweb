import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { refreshModelCatalogOnStartup } from "./model-refresh.js";
import { PiRuntime } from "./pi-runtime.js";
import { attachSocketServer } from "./socket-server.js";
import type { ReloadConversationTarget } from "./project-session-coordinator.js";

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
const server = app.listen(port, host, () => {
  console.log(`Pi Web: http://${host}:${port}`);
  process.send?.({ type: "piweb_ready" });
});

const socketServer = attachSocketServer(server, process.cwd(), runtime);
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
  shutdown();
  const forcedExit = setTimeout(() => process.exit(1), 5_000);
  forcedExit.unref();
});

function isReloadTarget(value: unknown): value is ReloadConversationTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return typeof target.cwd === "string"
    && typeof target.conversationId === "string"
    && typeof target.continueTask === "boolean";
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
    && Array.isArray(record.targets)
    && record.targets.every(isReloadTarget)
  ) {
    const requestId = record.requestId;
    void socketServer.resumeAfterReload(record.targets).then(
      (pending) => sendToSupervisor({
        type: "piweb_reload_resumed",
        requestId,
        pending,
      }),
      (error) => sendToSupervisor({
        type: "piweb_reload_failed",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    ).catch((error) => {
      console.error("Failed to report hot reload recovery", error);
    });
  }
});
