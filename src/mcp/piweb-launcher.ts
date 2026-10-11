import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { PiWebBridgeError } from "./piweb-session.js";

/** 一次分离启动所需的全部输入；Windows 下 commandLine 交给 cmd 解释。 */
export interface LaunchSpec {
  readonly commandLine: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** 非 Windows 没有新窗口，输出追加到这里。 */
  readonly logFile?: string;
}

export type LaunchDetached = (spec: LaunchSpec) => void;

export interface StartOptions {
  readonly baseUrl: URL;
  readonly repoRoot: string;
  readonly readyTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly launch?: LaunchDetached;
  readonly signal?: AbortSignal;
}

export type StartResult =
  | { readonly kind: "already_running" }
  | { readonly kind: "started"; readonly elapsedMs: number; readonly logFile?: string };

const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 1_000;

/** 只启动真正的 Pi Web 仓库，避免把任意目录的 npm start 当成工作台。 */
export function assertPiWebRoot(repoRoot: string): void {
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== "piweb" || !existsSync(join(repoRoot, "scripts", "piweb-supervisor.mjs"))) {
    throw new PiWebBridgeError(`找不到 Pi Web 项目目录：${repoRoot}`, "invalid_input");
  }
}

/** Windows 的环境变量名不区分大小写，必须改写已有的 Path 键而不是再加一个 PATH。 */
function withNodeFirstOnPath(env: NodeJS.ProcessEnv, nodePath: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const current = env[key];
  return { ...env, [key]: current ? `${dirname(nodePath)}${delimiter}${current}` : dirname(nodePath) };
}

export function piWebLaunchSpec(
  repoRoot: string,
  port: string,
  platform: NodeJS.Platform = process.platform,
  baseEnv: NodeJS.ProcessEnv = process.env,
  nodePath: string = process.execPath,
): LaunchSpec {
  // 与 open-piweb 相同地运行 npm start；npm 与 node 优先取运行本桥的同一套 Node。
  const env = { ...withNodeFirstOnPath(baseEnv, nodePath), PORT: port };
  if (platform === "win32") {
    return {
      // start 为服务开一个独立、可见的控制台窗口；用户关掉窗口即停止服务。
      // 运行期间 npm 会把窗口标题改成 “npm run start”。
      commandLine: "start \"Pi Web\" cmd /d /k npm run start",
      cwd: repoRoot,
      env,
    };
  }
  return {
    commandLine: "npm run start",
    cwd: repoRoot,
    env,
    logFile: join(repoRoot, "piweb-mcp-start.log"),
  };
}

/** 服务进程不能继承本桥的 stdio：本桥的 stdout 属于 MCP 协议。 */
export const launchDetached: LaunchDetached = (spec) => {
  const output = spec.logFile === undefined ? "ignore" : openSync(spec.logFile, "a");
  const child = spawn(spec.commandLine, {
    cwd: spec.cwd,
    env: spec.env,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", output, output],
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.unref();
};

export async function isPiWebHealthy(baseUrl: URL, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PiWebBridgeError("调用已取消：等待 Pi Web 启动", "cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 已在运行就什么都不做；否则分离启动一次并等 /health 就绪。
 * 同一仓库与端口的重复启动由 supervisor 的控制描述符拒绝，这里不另加锁。
 */
export async function startPiWeb(options: StartOptions): Promise<StartResult> {
  if (options.baseUrl.protocol !== "http:") {
    throw new PiWebBridgeError(`只能启动本机 http 地址上的 Pi Web：${options.baseUrl.origin}`, "invalid_input");
  }
  assertPiWebRoot(options.repoRoot);
  if (await isPiWebHealthy(options.baseUrl)) return { kind: "already_running" };
  const spec = piWebLaunchSpec(options.repoRoot, options.baseUrl.port || "80");
  const startedAt = Date.now();
  (options.launch ?? launchDetached)(spec);
  const deadline = startedAt + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await delay(options.pollIntervalMs ?? POLL_INTERVAL_MS, options.signal);
    if (await isPiWebHealthy(options.baseUrl)) {
      return {
        kind: "started",
        elapsedMs: Date.now() - startedAt,
        ...(spec.logFile === undefined ? {} : { logFile: spec.logFile }),
      };
    }
  }
  const where = spec.logFile === undefined
    ? "新打开的命令行窗口（标题为 npm run start）"
    : `日志 ${spec.logFile}`;
  throw new PiWebBridgeError(
    `Pi Web 在 ${Math.round((options.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)} 秒内没有准备好。请查看${where}里的错误。`,
    "unreachable",
  );
}
