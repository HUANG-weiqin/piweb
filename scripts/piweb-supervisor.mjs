import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyReloadResumeDispositions,
  completeReloadTarget,
  isPreparedReloadTargets,
  isReloadResumeDispositions,
  readReloadManifest,
  recordReloadTargets,
  reloadTargetsForChild,
} from "./piweb-reload-manifest.mjs";

const DEFAULT_PORT = 31415;
const MAX_RESUME_ATTEMPTS = 6;
const RESUME_RETRY_DELAY_MS = 1_000;
const MAX_RESUME_PASS_DELAY_MS = 30_000;
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--dev")) {
  console.error("Usage: node scripts/piweb-supervisor.mjs [--dev]");
  process.exitCode = 1;
} else {
  await runSupervisor(args[0] === "--dev");
}

async function runSupervisor(dev) {
  const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const appPort = readAppPort();
  const stateKey = createHash("sha256")
    .update(`${canonicalIdentity(repoRoot)}\0${appPort}`)
    .digest("hex")
    .slice(0, 24);
  const controlPath = join(tmpdir(), `piweb-supervisor-${stateKey}.json`);
  const manifestPath = join(tmpdir(), `piweb-reload-${stateKey}.json`);
  const token = randomBytes(32).toString("hex");

  let controlServer;
  let serverChild;
  let serverChildReady = false;
  let serverChildExit;
  let buildChild;
  let reloadOperation;
  let resumePromise;
  let resumeTimer;
  let resumePassDelayMs = RESUME_RETRY_DELAY_MS;
  let restartTimer;
  let unexpectedRestartUsed = false;
  let shuttingDown = false;
  let shutdownPromise;
  let resumeResponse;
  let resumeReconciledChild;
  let pendingResumeChild;
  let manifestMutation = Promise.resolve();

  function queueManifestMutation(mutation) {
    const result = manifestMutation.then(mutation, mutation);
    manifestMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  function unavailable(message) {
    const error = new Error(message);
    error.statusCode = 503;
    return error;
  }

  function sendIpc(child, message) {
    if (child.exitCode !== null || !child.connected) {
      return Promise.reject(unavailable("The server child is not connected."));
    }
    return new Promise((resolveSend, rejectSend) => {
      try {
        child.send(message, (error) => {
          if (error) {
            rejectSend(unavailable(`Failed to contact the server child: ${error.message}`));
          } else {
            resolveSend();
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        rejectSend(unavailable(`Failed to contact the server child: ${message}`));
      }
    });
  }

  function scheduleServerStart(delayMs) {
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!shuttingDown) startServerChild();
    }, delayMs);
  }

  function rejectResumeResponse(child) {
    const response = resumeResponse;
    if (!response || response.child !== child) return;
    resumeResponse = undefined;
    response.reject(unavailable("The server child exited during reload recovery."));
  }

  function handleUnexpectedExit(detail) {
    const reason = detail.error
      ? detail.error.message
      : `exit code ${detail.code ?? "null"}${detail.signal ? ` (${detail.signal})` : ""}`;
    if (unexpectedRestartUsed) {
      console.error(`Server child failed again (${reason}); supervisor is exiting.`);
      void shutdown(undefined, 1);
      return;
    }
    unexpectedRestartUsed = true;
    console.error(`Server child exited unexpectedly (${reason}); restarting once in 1 second.`);
    scheduleServerStart(1_000);
  }

  function handleChildExit(child, detail) {
    if (shuttingDown) return;
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
    const operation = reloadOperation;

    if (operation?.child === child && operation.phase === "stopping") {
      operation.phase = "starting";
      console.log("Server child stopped for reload; starting the replacement.");
      operation.manifestWrite.then(
        () => scheduleServerStart(0),
        () => void shutdown(undefined, 1),
      );
      return;
    }

    if (operation?.child === child && operation.phase === "preparing") {
      operation.rejectChildAcceptance(
        unavailable("The server child exited before freezing reload admission."),
      );
      reloadOperation = undefined;
      console.error(
        "Reload lost the server child before its snapshot; conversation recovery is not promised.",
      );
    } else if (operation?.phase === "resuming") {
      operation.phase = "starting";
    }
    handleUnexpectedExit(detail);
  }

  function startServerChild() {
    const childArgs = dev
      ? ["--import", "tsx/esm", "src/server/index.ts"]
      : ["dist-server/server/index.js"];
    const child = spawn(process.execPath, childArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    serverChild = child;
    serverChildReady = false;
    console.log(`Starting Pi Web server (${dev ? "development" : "production"}).`);

    let settled = false;
    let resolveExit;
    serverChildExit = new Promise((resolveChildExit) => {
      resolveExit = resolveChildExit;
    });
    function settle(detail) {
      if (settled) return;
      settled = true;
      if (serverChild === child) {
        serverChild = undefined;
        serverChildReady = false;
      }
      rejectResumeResponse(child);
      resolveExit();
      handleChildExit(child, detail);
    }

    child.on("message", (message) => handleChildMessage(child, message));
    child.once("error", (error) => settle({ error }));
    child.once("exit", (code, signal) => settle({ code, signal }));
    child.once("disconnect", () => {
      const plannedReloadExit = reloadOperation?.child === child
        && reloadOperation.phase === "stopping";
      if (!settled && !shuttingDown && !plannedReloadExit && child.exitCode === null) {
        console.error("Server child IPC disconnected; stopping the unowned child.");
        child.kill("SIGTERM");
      }
    });
  }

  function beginResume(child) {
    if (resumePromise) {
      pendingResumeChild = child;
      return;
    }
    pendingResumeChild = undefined;
    resumePromise = resumeFromManifest(child).finally(() => {
      resumePromise = undefined;
      const pending = pendingResumeChild;
      pendingResumeChild = undefined;
      if (
        pending
        && !shuttingDown
        && pending === serverChild
        && serverChildReady
      ) {
        beginResume(pending);
      }
    });
  }

  function scheduleResume(child) {
    if (resumeTimer || shuttingDown) return;
    const delay = resumePassDelayMs;
    resumePassDelayMs = Math.min(delay * 2, MAX_RESUME_PASS_DELAY_MS);
    resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (shuttingDown || child !== serverChild || !serverChildReady) return;
      if (reloadOperation || resumePromise) {
        scheduleResume(child);
      } else {
        beginResume(child);
      }
    }, delay);
  }

  function handleChildMessage(child, message) {
    if (child !== serverChild || !message || typeof message !== "object") return;

    if (message.type === "piweb_ready") {
      if (serverChildReady) return;
      serverChildReady = true;
      resumePassDelayMs = RESUME_RETRY_DELAY_MS;
      console.log("Pi Web server child is ready.");
      if (reloadOperation?.phase === "starting") {
        reloadOperation.phase = "resuming";
      }
      beginResume(child);
      return;
    }

    if (message.type === "piweb_reload_accepted") {
      const operation = reloadOperation;
      if (
        operation
        && operation.child === child
        && operation.phase === "preparing"
        && message.requestId === operation.requestId
      ) {
        operation.resolveChildAcceptance();
      }
      return;
    }

    if (message.type === "piweb_reload_ready") {
      const operation = reloadOperation;
      if (
        !operation
        || operation.child !== child
        || operation.phase !== "preparing"
        || message.requestId !== operation.requestId
      ) {
        return;
      }
      operation.resolveChildAcceptance();
      if (!isPreparedReloadTargets(message.targets)) {
        console.error("Server child returned an invalid reload target list.");
        child.kill("SIGTERM");
        return;
      }

      operation.phase = "stopping";
      operation.manifestWrite = queueManifestMutation(() =>
        recordReloadTargets(
          manifestPath,
          repoRoot,
          appPort,
          operation.requestId,
          message.targets,
        )
      );
      operation.manifestWrite.then(
        () => console.log(
          `Server child prepared reload ${operation.requestId} with ${message.targets.length} target(s).`,
        ),
        (error) => console.error(
          "Could not persist reload targets; supervisor will stop.",
          error,
        ),
      );
      return;
    }

    if (message.type === "piweb_reload_resumed") {
      const response = resumeResponse;
      if (
        !response
        || response.child !== child
        || response.requestId !== message.requestId
        || response.resumeId !== message.resumeId
      ) {
        return;
      }
      resumeResponse = undefined;
      if (!isReloadResumeDispositions(message.dispositions)) {
        response.reject(new Error("The server child returned invalid reload dispositions."));
      } else {
        response.resolve(message.dispositions);
      }
      return;
    }

    if (
      message.type === "piweb_reload_target_completed"
      && typeof message.requestId === "string"
      && typeof message.cwd === "string"
      && typeof message.conversationId === "string"
      && typeof message.runId === "string"
    ) {
      void queueManifestMutation(() => completeReloadTarget(
        manifestPath,
        repoRoot,
        appPort,
        message.requestId,
        {
          cwd: message.cwd,
          conversationId: message.conversationId,
          runId: message.runId,
        },
      )).then(
        async (removed) => {
          if (removed) {
            console.log(
              `Reload ${message.requestId} completed target ${message.conversationId}.`,
            );
          }
          if (child !== serverChild || !child.connected) return;
          await sendIpc(child, {
            type: removed
              ? "piweb_reload_target_completion_ack"
              : "piweb_reload_target_completion_rejected",
            requestId: message.requestId,
            cwd: message.cwd,
            conversationId: message.conversationId,
            runId: message.runId,
          });
        },
        (error) => {
          console.error("Could not record reload target completion.", error);
          if (child === serverChild && child.connected) child.kill("SIGTERM");
        },
      ).catch((error) => {
        console.error("Could not acknowledge reload target completion.", error);
        if (child === serverChild && child.connected) child.kill("SIGTERM");
      });
      return;
    }

    if (message.type === "piweb_reload_failed" && typeof message.requestId === "string") {
      const error = new Error(
        typeof message.message === "string" ? message.message : "The server child rejected reload.",
      );
      const response = resumeResponse;
      if (
        response?.child === child
        && response.requestId === message.requestId
      ) {
        resumeResponse = undefined;
        response.reject(error);
      }
      if (reloadOperation?.requestId === message.requestId) {
        reloadOperation.rejectChildAcceptance(error);
        reloadOperation = undefined;
      }
      console.error(`Reload ${message.requestId} failed in the server child: ${error.message}`);
      child.kill("SIGTERM");
    }
  }

  async function sendResumeAndWait(child, manifest, targets) {
    if (resumeResponse) {
      throw new Error("Reload recovery already has a pending child response.");
    }
    let resolveResponse;
    let rejectResponse;
    const responsePromise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const resumeId = randomUUID();
    const response = {
      requestId: manifest.requestId,
      resumeId,
      child,
      resolve: resolveResponse,
      reject: rejectResponse,
    };
    resumeResponse = response;
    try {
      await sendIpc(child, {
        type: "piweb_resume_reload",
        requestId: manifest.requestId,
        resumeId,
        targets,
      });
    } catch (error) {
      if (resumeResponse === response) resumeResponse = undefined;
      throw error;
    }
    return {
      dispositions: await responsePromise,
      resumeId,
    };
  }

  async function resumeFromManifest(child) {
    try {
      let manifest = await queueManifestMutation(() =>
        readReloadManifest(manifestPath, repoRoot, appPort)
      );
      if (!manifest) {
        await sendIpc(child, { type: "piweb_reload_reconciliation_complete" });
        resumePassDelayMs = RESUME_RETRY_DELAY_MS;
        if (reloadOperation?.phase === "resuming") reloadOperation = undefined;
        return;
      }

      let includeAdopted = resumeReconciledChild !== child;
      for (let attempt = 1; attempt <= MAX_RESUME_ATTEMPTS; attempt += 1) {
        if (shuttingDown || child !== serverChild || !serverChildReady) {
          throw unavailable("The server child changed during reload recovery.");
        }
        // Exactly one pass per child reconciles every durable target,
        // including prior adoptions. Later passes in the same child retry only
        // targets which still have no owner.
        const targets = reloadTargetsForChild(manifest, includeAdopted);
        if (targets.length === 0) {
          resumePassDelayMs = RESUME_RETRY_DELAY_MS;
          break;
        }
        if (includeAdopted) {
          resumeReconciledChild = child;
          includeAdopted = false;
        }
        const { dispositions, resumeId } = await sendResumeAndWait(
          child,
          manifest,
          targets,
        );
        const applied = await queueManifestMutation(() =>
          applyReloadResumeDispositions(
            manifestPath,
            repoRoot,
            appPort,
            manifest.requestId,
            targets,
            dispositions,
          )
        );
        if (applied.stale || !applied.manifest) {
          throw new Error("Reload dispositions lost their exact manifest authority.");
        }
        await sendIpc(child, {
          type: "piweb_reload_resumed_applied",
          requestId: manifest.requestId,
          resumeId,
        });
        manifest = applied.manifest;

        const retryCount = manifest.targets.filter(
          (target) => target.state === "unadopted",
        ).length;
        if (retryCount === 0) {
          resumePassDelayMs = RESUME_RETRY_DELAY_MS;
          break;
        }
        if (attempt === MAX_RESUME_ATTEMPTS) {
          console.warn(
            `Reload ${manifest.requestId} still has ${retryCount} unadopted target(s); scheduling another recovery pass.`,
          );
          scheduleResume(child);
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, RESUME_RETRY_DELAY_MS));
      }

      if (reloadOperation?.phase === "resuming") {
        console.log(`Reload ${reloadOperation.requestId} recovery pass completed.`);
        reloadOperation = undefined;
      }
    } catch (error) {
      if (shuttingDown) return;
      console.error(
        "Reload recovery was interrupted; the manifest remains for a later child.",
        error instanceof Error ? error.message : error,
      );
      if (child === serverChild && child.connected) child.kill("SIGTERM");
    }
  }

  function runBuild() {
    const command = process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : "npm";
    const commandArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm run build"]
      : ["run", "build"];
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    buildChild = child;
    return new Promise((resolveBuild, rejectBuild) => {
      let settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        if (buildChild === child) buildChild = undefined;
        if (error) rejectBuild(error);
        else resolveBuild();
      }
      child.once("error", (error) => finish(new Error(`Could not start build: ${error.message}`)));
      child.once("exit", (code, signal) => {
        if (code === 0) finish();
        else finish(new Error(
          `Build failed with exit code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`,
        ));
      });
    });
  }

  async function prepareReload(operation) {
    try {
      console.log(`Building reload ${operation.requestId}.`);
      await runBuild();
      if (shuttingDown) throw unavailable("The supervisor is shutting down.");
      if (!serverChild || !serverChildReady || !serverChild.connected) {
        throw unavailable("Build succeeded, but the server child is not ready for reload.");
      }

      operation.child = serverChild;
      operation.phase = "preparing";
      await sendIpc(serverChild, {
        type: "piweb_prepare_reload",
        requestId: operation.requestId,
        force: operation.force,
      });
      await operation.childAcceptance;
      console.log(`Reload ${operation.requestId} accepted after a successful build.`);
    } catch (error) {
      if (reloadOperation === operation) reloadOperation = undefined;
      throw error;
    }
  }

  function createReloadOperation(force) {
    let resolveChildAcceptance;
    let rejectChildAcceptance;
    const childAcceptance = new Promise((resolve, reject) => {
      resolveChildAcceptance = resolve;
      rejectChildAcceptance = reject;
    });
    // The promise can be rejected during supervisor shutdown before an HTTP
    // caller awaits it; keep that control-path rejection observed.
    void childAcceptance.catch(() => undefined);
    const operation = {
      requestId: randomUUID(),
      force,
      phase: "building",
      child: undefined,
      manifestWrite: Promise.resolve(),
      childAcceptance,
      resolveChildAcceptance,
      rejectChildAcceptance,
      acceptance: undefined,
    };
    operation.acceptance = prepareReload(operation);
    return operation;
  }

  async function acceptReload(force) {
    if (shuttingDown) throw unavailable("The supervisor is shutting down.");
    if (!reloadOperation && resumePromise) {
      throw unavailable("The server child is still recovering a reload manifest.");
    }

    const operation = reloadOperation ?? createReloadOperation(force);
    reloadOperation ??= operation;
    if (force && !operation.force) {
      if (operation.phase !== "building") {
        throw unavailable(
          "A non-forced reload is already draining; retry --force after it completes.",
        );
      }
      operation.force = true;
    }

    await operation.acceptance;
    return { requestId: operation.requestId };
  }

  function authorized(header) {
    if (typeof header !== "string") return false;
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async function handleControlRequest(request, response) {
    if (!authorized(request.headers.authorization)) {
      sendJson(response, 401, { status: "unauthorized" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/reload") {
      sendJson(response, 404, { status: "not_found" });
      return;
    }
    const forceValue = url.searchParams.get("force");
    if (forceValue !== null && forceValue !== "1") {
      sendJson(response, 400, { status: "invalid_request" });
      return;
    }

    try {
      const accepted = await acceptReload(forceValue === "1");
      sendJson(response, 202, { status: "accepted", ...accepted });
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      sendJson(response, statusCode, {
        status: statusCode === 503 ? "unavailable" : "build_failed",
        message: error instanceof Error ? error.message : "Reload failed.",
      });
    }
  }

  function closeControlServer() {
    if (!controlServer?.listening) return Promise.resolve();
    return new Promise((resolveClose, rejectClose) => {
      controlServer.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }

  async function removeOwnControlDescriptor() {
    try {
      const current = JSON.parse(await readFile(controlPath, "utf8"));
      if (current.pid === process.pid && current.token === token) {
        await rm(controlPath, { force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("Could not clean up the supervisor control descriptor.");
      }
    }
  }

  function stopProcess(child, signal) {
    if (!child || child.exitCode !== null) return;
    const forceTimer = setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch {
        // The process ended between the exit-code check and forced kill.
      }
    }, 5_000);
    forceTimer.unref();
    child.once("exit", () => clearTimeout(forceTimer));
    try {
      child.kill(signal);
    } catch {
      clearTimeout(forceTimer);
      // Its exit event owns cleanup if it ended concurrently.
    }
  }

  function shutdown(signal = "SIGTERM", exitCode = 0) {
    shutdownPromise ??= (async () => {
      shuttingDown = true;
      reloadOperation?.rejectChildAcceptance(
        unavailable("The supervisor is shutting down."),
      );
      if (restartTimer) clearTimeout(restartTimer);
      if (resumeTimer) clearTimeout(resumeTimer);
      const controlClose = closeControlServer();
      stopProcess(buildChild, signal);
      stopProcess(serverChild, signal);
      await Promise.allSettled([
        controlClose,
        serverChildExit,
        resumePromise,
        manifestMutation,
      ].filter(Boolean));
      await removeOwnControlDescriptor();
      process.exitCode = exitCode;
    })();
    return shutdownPromise;
  }

  try {
    controlServer = createServer((request, response) => {
      void handleControlRequest(request, response);
    });
    controlServer.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolveListen, rejectListen) => {
      controlServer.once("error", rejectListen);
      controlServer.listen(0, "127.0.0.1", () => {
        controlServer.off("error", rejectListen);
        resolveListen();
      });
    });

    const address = controlServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine the supervisor control port.");
    }
    await claimControlDescriptor(controlPath, {
      version: 1,
      pid: process.pid,
      repoCwd: repoRoot,
      appPort,
      controlPort: address.port,
      token,
    });

    console.log(`Pi Web supervisor control is ready for app port ${appPort}.`);
    process.once("SIGINT", () => void shutdown("SIGINT", 0));
    process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
    startServerChild();
  } catch (error) {
    console.error("Failed to start Pi Web supervisor.", error);
    await shutdown(undefined, 1);
  }
}

function canonicalIdentity(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function readAppPort() {
  const rawPort = process.env.PORT ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(rawPort)) throw new Error(`Invalid PORT: ${rawPort}`);
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  return port;
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  response.end(payload);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function claimControlDescriptor(path, descriptor) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
      await handle.close();
      handle = undefined;
      try {
        await chmod(path, 0o600);
      } catch {
        // Windows may not enforce POSIX modes; the random token remains mandatory.
      }
      return;
    } catch (error) {
      await handle?.close();
      if (error?.code !== "EEXIST") {
        await rm(path, { force: true });
        throw error;
      }

      let existing;
      try {
        existing = JSON.parse(await readFile(path, "utf8"));
      } catch {
        const info = await stat(path).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs < 5_000) {
          throw new Error("Another Pi Web supervisor is claiming this repo and PORT.");
        }
      }
      if (existing && processIsAlive(existing.pid)) {
        throw new Error(`Pi Web supervisor ${existing.pid} already owns this repo and PORT.`);
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not claim the Pi Web supervisor control descriptor.");
}
