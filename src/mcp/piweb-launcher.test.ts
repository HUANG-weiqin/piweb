import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPiWebRoot,
  piWebLaunchSpec,
  startPiWeb,
  type LaunchSpec,
} from "./piweb-launcher.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fakeRepo(name = "piweb"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "piweb-launcher-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name }));
  await writeFile(join(root, "scripts", "piweb-supervisor.mjs"), "");
  return root;
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function healthServer(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: request.url === "/health" }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return server;
}

describe("piWebLaunchSpec", () => {
  it("opens a separate visible console on Windows and keeps one PATH entry", () => {
    const spec = piWebLaunchSpec(
      "E:\\piweb",
      "31415",
      "win32",
      { Path: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      "C:\\Program Files\\nodejs\\node.exe",
    );
    expect(spec.commandLine).toBe("start \"Pi Web\" cmd /d /k npm run start");
    expect(spec.cwd).toBe("E:\\piweb");
    expect(spec.logFile).toBeUndefined();
    expect(spec.env.PORT).toBe("31415");
    expect(Object.keys(spec.env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["Path"]);
    expect(spec.env.Path?.startsWith("C:\\Program Files\\nodejs")).toBe(true);
  });

  it("runs detached with a log file elsewhere", () => {
    const spec = piWebLaunchSpec("/repo", "4000", "linux", { PATH: "/usr/bin" }, "/opt/node/bin/node");
    expect(spec.commandLine).toBe("npm run start");
    expect(spec.logFile).toBe(join("/repo", "piweb-mcp-start.log"));
    expect(spec.env.PATH?.startsWith("/opt/node/bin")).toBe(true);
  });
});

describe("startPiWeb", () => {
  it("refuses directories that are not a Pi Web checkout", async () => {
    expect(() => assertPiWebRoot(tmpdir())).toThrow("找不到 Pi Web 项目目录");
    const other = await fakeRepo("something-else");
    await expect(startPiWeb({ baseUrl: new URL("http://127.0.0.1:9"), repoRoot: other }))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does nothing when Pi Web already answers its health check", async () => {
    const port = await freePort();
    await healthServer(port);
    const launch = vi.fn();
    await expect(startPiWeb({
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      repoRoot: await fakeRepo(),
      launch,
    })).resolves.toEqual({ kind: "already_running" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches once with the bridge port and waits until the service is healthy", async () => {
    const port = await freePort();
    const repoRoot = await fakeRepo();
    const launches: LaunchSpec[] = [];
    const result = await startPiWeb({
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      repoRoot,
      pollIntervalMs: 20,
      readyTimeoutMs: 5_000,
      launch: (spec) => {
        launches.push(spec);
        setTimeout(() => void healthServer(port), 100);
      },
    });
    expect(result.kind).toBe("started");
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ cwd: repoRoot, env: expect.objectContaining({ PORT: String(port) }) });
  });

  it("reports where to look when the service never becomes ready", async () => {
    const port = await freePort();
    const launch = vi.fn();
    await expect(startPiWeb({
      baseUrl: new URL(`http://127.0.0.1:${port}`),
      repoRoot: await fakeRepo(),
      pollIntervalMs: 20,
      readyTimeoutMs: 200,
      launch,
    })).rejects.toMatchObject({ code: "unreachable" });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("only starts plain-http loopback services", async () => {
    await expect(startPiWeb({
      baseUrl: new URL("https://localhost:31415"),
      repoRoot: await fakeRepo(),
    })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
