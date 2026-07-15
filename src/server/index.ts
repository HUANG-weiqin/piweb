import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { attachSocketServer } from "./socket-server.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? 31415);
const app = express();
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist-client");

app.disable("x-powered-by");
app.get("/health", (_request, response) => response.json({ ok: true }));
app.use(express.static(clientDir, { index: false }));
app.get("/{*path}", (_request, response) => response.sendFile(resolve(clientDir, "index.html")));

const server = app.listen(port, host, () => {
  console.log(`Pi Web: http://${host}:${port}`);
});

attachSocketServer(server, process.cwd());

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
