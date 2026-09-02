import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 31415;
const args = process.argv.slice(2);

if (args.length > 1 || (args.length === 1 && args[0] !== "--force")) {
  console.error("Usage: npm run reload -- [--force]");
  process.exitCode = 1;
} else {
  try {
    const force = args[0] === "--force";
    const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    const appPort = readAppPort();
    const identityRoot = process.platform === "win32" ? repoRoot.toLowerCase() : repoRoot;
    const descriptorKey = createHash("sha256")
      .update(`${identityRoot}\0${appPort}`)
      .digest("hex")
      .slice(0, 24);
    const descriptorPath = join(tmpdir(), `piweb-supervisor-${descriptorKey}.json`);
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));

    if (
      !descriptor
      || typeof descriptor !== "object"
      || descriptor.version !== 1
      || descriptor.repoCwd !== repoRoot
      || descriptor.appPort !== appPort
      || !Number.isSafeInteger(descriptor.pid)
      || descriptor.pid <= 0
      || !Number.isSafeInteger(descriptor.controlPort)
      || descriptor.controlPort <= 0
      || descriptor.controlPort > 65_535
      || typeof descriptor.token !== "string"
      || !/^[a-f0-9]{64}$/.test(descriptor.token)
    ) {
      throw new Error("The Pi Web supervisor control descriptor is invalid.");
    }

    const response = await requestReload(descriptor, force);
    if (
      response.statusCode !== 202
      || response.body?.status !== "accepted"
      || typeof response.body.requestId !== "string"
    ) {
      throw new Error(
        response.body?.message
          ?? `The Pi Web supervisor rejected reload (HTTP ${response.statusCode}).`,
      );
    }

    console.log(`Reload accepted: ${response.body.requestId}`);
  } catch (error) {
    let message = error;
    if (error instanceof Error) {
      message = error.code === "ENOENT"
        ? "No Pi Web supervisor is running for this repo and PORT."
        : error.message;
    }
    console.error("Reload failed:", message);
    process.exitCode = 1;
  }
}

function readAppPort() {
  const rawPort = process.env.PORT ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }
  return port;
}

function requestReload(descriptor, force) {
  return new Promise((resolveRequest, rejectRequest) => {
    const controlRequest = request({
      host: "127.0.0.1",
      port: descriptor.controlPort,
      method: "POST",
      path: force ? "/reload?force=1" : "/reload",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        connection: "close",
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          response.destroy(new Error("The supervisor response exceeded 64 KiB."));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", rejectRequest);
      response.once("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolveRequest({
            statusCode: response.statusCode,
            body: text ? JSON.parse(text) : undefined,
          });
        } catch (error) {
          rejectRequest(new Error(
            `The supervisor returned an invalid response: ${error instanceof Error ? error.message : "unknown error"}`,
          ));
        }
      });
    });
    controlRequest.once("error", rejectRequest);
    controlRequest.end();
  });
}
