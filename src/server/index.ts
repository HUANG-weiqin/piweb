import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { refreshModelCatalogOnStartup } from "./model-refresh.js";
import { PiRuntime } from "./pi-runtime.js";
import { attachSocketServer } from "./socket-server.js";

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
    },
    (error) => {
      console.error("Failed to shut down cleanly", error);
      process.exitCode = 1;
    },
  );
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
