#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(repoRoot, ".visual-validation");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const defaultViewports = [
  [1440, 900],
  [1920, 1080],
  [3440, 1440],
  [390, 844],
];

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const argument = process.argv[i];
  if (!argument.startsWith("--")) continue;
  const [key, inlineValue] = argument.slice(2).split("=", 2);
  const value = inlineValue ?? process.argv[i + 1];
  if (inlineValue === undefined && value && !value.startsWith("--")) i += 1;
  args.set(key, value ?? true);
}

const visualFixture = args.has("fixture");
let baseUrl = String(args.get("url") ?? "http://127.0.0.1:5173/");
if (visualFixture) {
  const fixtureUrl = new URL(baseUrl);
  fixtureUrl.searchParams.set("fixture", "workbench");
  baseUrl = fixtureUrl.toString();
}
const requestedViewport = args.get("viewport");
const viewports = requestedViewport
  ? [String(requestedViewport).split("x").map(Number)]
  : visualFixture
    ? [[1920, 1080], [1440, 900]]
    : defaultViewports;
const waitMs = Number(args.get("wait") ?? 900);
const reducedMotion = args.has("reduced-motion");

function assertViewport(viewport) {
  if (viewport.length !== 2 || viewport.some((value) => !Number.isFinite(value) || value < 200)) {
    throw new Error(`Invalid viewport: ${viewport.join("x")}`);
  }
  return { width: viewport[0], height: viewport[1] };
}

function browserCandidates() {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    process.env.PIWEB_BROWSER,
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
}

function findBrowser() {
  const browser = browserCandidates().find((candidate) => existsSync(candidate));
  if (!browser) {
    throw new Error("No Chromium-compatible browser found. Set PIWEB_BROWSER to its executable path.");
  }
  return browser;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForJson(url, timeoutMs = 10_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "unknown error"}`);
}

class CdpClient {
  #socket;
  #nextId = 0;
  #pending = new Map();

  constructor(url) {
    this.#socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolveOpen, rejectOpen) => {
      this.#socket.once("open", resolveOpen);
      this.#socket.once("error", rejectOpen);
    });
    this.#socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = ++this.#nextId;
    return new Promise((resolveCall, rejectCall) => {
      this.#pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
    }
    return result.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

async function captureViewport(client, outputPath, width, height, index) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 600,
  });
  await client.call("Page.navigate", { url: baseUrl });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));

  if (visualFixture) {
    const ready = await client.evaluate(`(() => {
      const fixture = document.querySelector('[data-visual-fixture="populated-workbench"]');
      const tasks = fixture?.querySelector('.loop-list-toggle');
      if (!fixture || !tasks) return false;
      if (
        tasks.getClientRects().length > 0
        && tasks.getAttribute('aria-expanded') !== 'true'
      ) tasks.click();
      if (innerWidth <= 600) {
        const sidebar = fixture.querySelector('.conversation-sidebar-toggle');
        if (sidebar?.getAttribute('aria-expanded') === 'true') sidebar.click();
      }
      return true;
    })()`);
    if (!ready) {
      throw new Error(`Populated workbench fixture was not ready at ${width}x${height}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    if (width > 600) {
      await client.evaluate(`(() => {
        const transcript = document.querySelector('.transcript');
        if (transcript) transcript.scrollTop = 0;
      })()`);
    }
    const missingSurfaces = await client.evaluate(`(() => {
      const missionVisible = document.querySelector('.mission-command')
        ?.getClientRects().length > 0;
      const commandSelectors = [
        '.composer',
        '.composer-command-label',
        '.composer textarea',
        '.composer-meta',
        '.send.stop',
        '.send:not(.stop)',
      ];
      const selectors = [
        '.workspace-rail',
        '.conversation-sidebar',
        ...(innerWidth > 600 ? ['.compaction-marker', '.message.user'] : []),
        '.assistant-activity-group.is-active',
        '.commitment-card',
        ...(missionVisible
          ? [
            '.mission-command',
            '.mission-objective-list',
            '.mission-context',
            '.mission-activity',
          ]
          : ['.loop-list-items']),
        ...commandSelectors,
      ];
      const issues = selectors.flatMap((selector) => {
        const element = document.querySelector(selector);
        if (!element) return [selector + ' (missing)'];
        const rect = element.getBoundingClientRect();
        return rect.bottom <= 0 || rect.right <= 0
          || rect.top >= innerHeight || rect.left >= innerWidth
          ? [selector + ' (' + Math.round(rect.left) + ',' + Math.round(rect.top)
              + '–' + Math.round(rect.right) + ',' + Math.round(rect.bottom) + ')']
          : [];
      });
      for (const selector of commandSelectors) {
        const element = document.querySelector(selector);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (rect.left < -1 || rect.top < -1
            || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) {
          issues.push(selector + ' (clipped ' + Math.round(rect.left) + ','
            + Math.round(rect.top) + '–' + Math.round(rect.right) + ','
            + Math.round(rect.bottom) + ')');
        }
      }
      const textarea = document.querySelector('.composer textarea');
      if (textarea?.getBoundingClientRect().width < 80) {
        issues.push('.composer textarea (narrow)');
      }
      return issues;
    })()`);
    if (missingSurfaces.length > 0) {
      throw new Error(`Fixture surfaces outside the screenshot: ${missingSurfaces.join(', ')}`);
    }
  }

  const diagnostics = JSON.parse(
    await client.evaluate(`JSON.stringify((() => {
      const root = document.documentElement;
      const workbench = document.querySelector('.workbench');
      const appRoot = workbench
        ?? document.querySelector('.role-selection-page')
        ?? document.querySelector('.setup-shell');
      const dialog = document.querySelector('[role="dialog"]');
      const animations = [...document.querySelectorAll('*')]
        .map((element) => getComputedStyle(element).animationName)
        .filter((name) => name && name !== 'none');
      return {
        title: document.title,
        appRoot: appRoot?.className ?? null,
        viewport: [innerWidth, innerHeight],
        document: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight },
        overflow: root.scrollWidth > innerWidth + 1,
        layout: workbench ? getComputedStyle(workbench).gridTemplateColumns : null,
        dialog: dialog?.getAttribute('aria-label') ?? null,
        activeElement: document.activeElement?.tagName ?? null,
        animations: [...new Set(animations)].slice(0, 12),
        missionVisible: document.querySelector('.mission-command')
          ?.getClientRects().length > 0,
      };
    })())`),
  );

  if (!diagnostics.appRoot) {
    throw new Error(`Expected Pi Web app root was not rendered at ${width}x${height}`);
  }
  const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
  const name = `${String(index + 1).padStart(2, "0")}-${width}x${height}${visualFixture ? "-fixture" : ""}${reducedMotion ? "-reduced" : ""}.png`;
  await writeFile(join(outputPath, name), Buffer.from(screenshot.data, "base64"));
  return { name, ...diagnostics };
}

async function checkSetupFlow(client) {
  const opened = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.includes('开启工作区'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!opened) {
    throw new Error('Setup flow trigger "开启工作区" was not found');
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
  const dialog = await client.evaluate(`document.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? null`);
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
  const closed = await client.evaluate(`!document.querySelector('[role="dialog"]')`);
  return { available: true, openedDialog: dialog, escapeClosed: closed };
}

async function stopBrowser(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolveStop) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("close", resolveStop);
      killer.once("error", resolveStop);
    });
  } else {
    child.kill("SIGTERM");
  }
}

async function main() {
  for (const viewport of viewports) assertViewport(viewport);
  const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`Visual verification target returned ${response.status} ${response.statusText}: ${baseUrl}`);
  }
  const browser = findBrowser();
  const runDir = join(outputDir, runId);
  await mkdir(runDir, { recursive: true });
  const profileDir = await mkdtemp(join(runDir, ".browser-profile-"));
  const port = await freePort();
  const child = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--disable-background-networking",
    "--hide-scrollbars",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find((item) => item.type === "page");
    if (!target) throw new Error("Chromium did not expose a page target");
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.open();
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    if (reducedMotion) {
      await client.call("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
    }

    const captures = [];
    for (const [index, viewport] of viewports.entries()) {
      captures.push(await captureViewport(client, runDir, viewport[0], viewport[1], index));
    }
    const setupFlow = visualFixture ? null : await checkSetupFlow(client);
    client.close();

    const manifest = {
      generatedAt: new Date().toISOString(),
      url: baseUrl,
      browser,
      reducedMotion,
      ...(visualFixture ? { fixture: "workbench" } : {}),
      captures,
      setupFlow,
    };
    await writeFile(join(runDir, `manifest${reducedMotion ? "-reduced" : ""}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
    if (captures.some((capture) => capture.overflow)) throw new Error("Horizontal overflow detected in one or more viewports");
    if (!visualFixture && (!setupFlow.openedDialog || !setupFlow.escapeClosed)) {
      throw new Error("Setup dialog interaction check failed");
    }
  } finally {
    await stopBrowser(child);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    await rm(profileDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150,
    });
  }
}

main().catch((error) => {
  console.error(`[visual-verify] ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
