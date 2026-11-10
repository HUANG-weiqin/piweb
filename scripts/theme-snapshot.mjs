#!/usr/bin/env node

// Records the computed CSS of fixed fixture pages under one or more themes,
// and compares two recordings. Use it to prove a CSS refactor changed nothing
// visible:
//
//   node scripts/theme-snapshot.mjs capture --url http://127.0.0.1:5173/ --out run1.json
//   node scripts/theme-snapshot.mjs compare run1.json run2.json [--limit 40]
//
// Helpers (browser discovery, CDP client, port and profile handling) are copied
// from scripts/visual-verify.mjs on purpose; this script does not import it.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";

// Copied from visual-verify.mjs secondarySurfaceDefinitions (key names only).
const SECONDARY_SURFACE_NAMES = [
  "drawer",
  "drawer-appearance",
  "drawer-model-connections",
  "role-manager",
  "role-switch",
  "directory",
  "auth",
  "extension",
  "feedback",
  "context-tooltip",
  "activity-expanded",
  "commitment-expanded",
  "jump-latest",
  "jump-latest-focus",
  "composer-states",
  "setup",
  "role-selection",
  "empty",
  "opening",
  "unavailable",
  "error-boundary",
];

const DEFAULT_THEMES = ["quiet-rebel", "classic-rebel"];
const DEFAULT_SKIN_MAP = {
  "quiet-rebel": "rebel",
  "classic-rebel": "rebel",
};

const PROPERTIES = [
  "color",
  "background-color",
  "background-image",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "box-shadow",
  "text-shadow",
  "clip-path",
  "transform",
  "rotate",
  "translate",
  "scale",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "line-height",
  "text-transform",
  "text-decoration-line",
  "opacity",
  "filter",
  "backdrop-filter",
  "outline-color",
  "outline-style",
  "outline-width",
  "outline-offset",
  "fill",
  "stroke",
  "visibility",
  "display",
  "transition-property",
  "transition-duration",
  "transition-timing-function",
  "animation-name",
  "animation-duration",
  "animation-timing-function",
];
const PSEUDO_PROPERTIES = [...PROPERTIES, "content"];

// ---------------------------------------------------------------------------
// Helpers copied from scripts/visual-verify.mjs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Page-side collector. It is serialized with Function#toString and evaluated
// in the page, so it must not reference anything from this Node module.
// ---------------------------------------------------------------------------

function collectComputedStyles(properties, pseudoProperties) {
  const readStyle = (style, names) => {
    const values = {};
    for (const name of names) values[name] = style.getPropertyValue(name);
    return values;
  };
  const round = (value) => Math.round(value * 100) / 100;
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return [round(rect.x), round(rect.y), round(rect.width), round(rect.height)].join(" ");
  };
  const segmentOf = (element, position) => {
    let segment = element.tagName.toLowerCase();
    if (element.id) segment += "#" + element.id;
    const classes = (element.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .sort();
    if (classes.length > 0) segment += "." + classes.join(".");
    return segment + ":nth-child(" + position + ")";
  };
  const result = {};
  const record = (key, element) => {
    const entry = readStyle(getComputedStyle(element), properties);
    entry.rect = rectOf(element);
    result[key] = entry;
    for (const pseudo of ["::before", "::after"]) {
      const pseudoStyle = getComputedStyle(element, pseudo);
      const content = pseudoStyle.getPropertyValue("content");
      if (content === "none" || content === "normal") continue;
      result[key + pseudo] = readStyle(pseudoStyle, pseudoProperties);
    }
  };
  const visit = (element, key) => {
    record(key, element);
    [...element.children].forEach((child, index) => {
      visit(child, key + " > " + segmentOf(child, index + 1));
    });
  };
  record("html", document.documentElement);
  visit(document.body, "body");
  return JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

function buildScenes(baseUrl) {
  const scenes = [
    { name: "workbench@1440x900", fixture: "workbench", width: 1440, height: 900 },
    { name: "workbench@390x844", fixture: "workbench", width: 390, height: 844 },
  ];
  for (const surface of SECONDARY_SURFACE_NAMES) {
    scenes.push({ name: `${surface}@1440x900`, fixture: "secondary", surface, width: 1440, height: 900 });
  }
  return scenes.map((scene) => {
    const url = new URL(baseUrl);
    url.searchParams.set("fixture", scene.fixture === "workbench" ? "workbench" : "secondary");
    if (scene.surface) url.searchParams.set("surface", scene.surface);
    return { ...scene, url: url.toString() };
  });
}

function parseList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSkinMap(value) {
  const map = {};
  for (const pair of parseList(value)) {
    const [id, skin] = pair.split("=").map((part) => part.trim());
    if (!id || !skin) throw new Error(`Invalid --skin-map entry: ${pair}`);
    map[id] = skin;
  }
  return map;
}

async function waitForFixture(client, scene, timeoutMs = 20_000) {
  const readyExpression = scene.fixture === "workbench"
    ? `!!document.querySelector('[data-visual-fixture="populated-workbench"] .loop-list-toggle')`
    : `document.querySelectorAll(${JSON.stringify(
      `[data-visual-fixture="secondary-surfaces"][data-visual-surface="${scene.surface}"]`,
    )}).length === 1`;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(readyExpression)) return;
    } catch (error) {
      // The page may still be navigating; keep polling.
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Fixture was not ready for ${scene.name}${lastError ? `: ${lastError.message}` : ""}`);
}

async function prepareWorkbench(client, scene) {
  // Same preparation visual-verify applies to the populated workbench fixture.
  await client.evaluate(`(() => {
    const fixture = document.querySelector('[data-visual-fixture="populated-workbench"]');
    const tasks = fixture?.querySelector('.loop-list-toggle');
    if (!fixture || !tasks) return false;
    if (tasks.getClientRects().length > 0 && tasks.getAttribute('aria-expanded') !== 'true') tasks.click();
    return true;
  })()`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  if (scene.width > 600) {
    await client.evaluate(`(() => {
      const transcript = document.querySelector('.transcript');
      if (transcript) transcript.scrollTop = 0;
    })()`);
  }
}

async function captureScene(client, scene, theme, skin) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    width: scene.width,
    height: scene.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const navigation = await client.call("Page.navigate", { url: scene.url });
  if (navigation.errorText) throw new Error(`Navigation failed for ${scene.name}: ${navigation.errorText}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
  await waitForFixture(client, scene);
  if (scene.fixture === "workbench") await prepareWorkbench(client, scene);

  const expression = `(async () => {
    const frame = () => new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
    document.documentElement.dataset.colorScheme = ${JSON.stringify(theme)};
    document.documentElement.dataset.skin = ${JSON.stringify(skin)};
    await frame();
    await frame();
    await sleep(300);
    document.getAnimations().forEach((animation) => {
      animation.pause();
      animation.currentTime = 0;
    });
    await frame();
    await document.fonts.ready;
    return (${collectComputedStyles.toString()})(${JSON.stringify(PROPERTIES)}, ${JSON.stringify(PSEUDO_PROPERTIES)});
  })()`;
  const json = await client.evaluate(expression);
  return JSON.parse(json);
}

async function capture(options) {
  const url = options.get("url");
  const out = options.get("out");
  if (typeof url !== "string" || url === "") throw new Error("capture requires --url");
  if (typeof out !== "string" || out === "") throw new Error("capture requires --out");

  const themes = options.has("themes") ? parseList(options.get("themes")) : DEFAULT_THEMES;
  if (themes.length === 0) throw new Error("--themes is empty");
  const skinMap = { ...DEFAULT_SKIN_MAP, ...(options.has("skin-map") ? parseSkinMap(options.get("skin-map")) : {}) };
  const sceneFilters = options.has("scenes") ? parseList(options.get("scenes")) : null;

  let scenes = buildScenes(url);
  if (sceneFilters) {
    scenes = scenes.filter((scene) => sceneFilters.some((filter) => scene.name.startsWith(filter)));
    if (scenes.length === 0) throw new Error(`--scenes matched no scenes: ${sceneFilters.join(",")}`);
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Target returned ${response.status} ${response.statusText}: ${url}`);

  const browser = findBrowser();
  const profileDir = await mkdtemp(join(tmpdir(), "theme-snapshot-"));
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

  const started = Date.now();
  const scenesOut = {};
  let client;
  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find((item) => item.type === "page");
    if (!target) throw new Error("Chromium did not expose a page target");
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.open();
    await client.call("Page.enable");
    await client.call("Runtime.enable");

    let elementTotal = 0;
    for (const [index, scene] of scenes.entries()) {
      for (const theme of themes) {
        const skin = skinMap[theme] ?? theme;
        const stepStarted = Date.now();
        const record = await captureScene(client, scene, theme, skin);
        const count = Object.keys(record).length;
        elementTotal += count;
        scenesOut[`${scene.name}|${theme}`] = record;
        console.log(
          `[${index + 1}/${scenes.length}] ${scene.name} | ${theme} (skin ${skin}): ${count} entries, ${Date.now() - stepStarted} ms`,
        );
      }
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    const payload = {
      meta: { url, createdAt: new Date().toISOString(), themes },
      scenes: scenesOut,
    };
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(payload));
    console.log(
      `Captured ${scenes.length} scenes x ${themes.length} themes = ${Object.keys(scenesOut).length} entries (${elementTotal} element records) in ${elapsed} s -> ${out}`,
    );
  } finally {
    client?.close();
    await stopBrowser(child);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

function compareRecordings(a, b) {
  const sceneNames = [...new Set([...Object.keys(a.scenes), ...Object.keys(b.scenes)])].sort();
  const result = {
    scenesOnlyA: [],
    scenesOnlyB: [],
    keysOnlyA: [],
    keysOnlyB: [],
    changes: [],
    scenesCompared: 0,
  };
  for (const scene of sceneNames) {
    const left = a.scenes[scene];
    const right = b.scenes[scene];
    if (!left) {
      result.scenesOnlyB.push(scene);
      continue;
    }
    if (!right) {
      result.scenesOnlyA.push(scene);
      continue;
    }
    result.scenesCompared += 1;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    for (const key of keys) {
      const leftEntry = left[key];
      const rightEntry = right[key];
      if (!leftEntry) {
        result.keysOnlyB.push({ scene, key });
        continue;
      }
      if (!rightEntry) {
        result.keysOnlyA.push({ scene, key });
        continue;
      }
      const props = [...new Set([...Object.keys(leftEntry), ...Object.keys(rightEntry)])];
      for (const prop of props) {
        const hasLeft = Object.hasOwn(leftEntry, prop);
        const hasRight = Object.hasOwn(rightEntry, prop);
        const leftValue = hasLeft ? leftEntry[prop] : "<missing>";
        const rightValue = hasRight ? rightEntry[prop] : "<missing>";
        if (leftValue !== rightValue) {
          result.changes.push({ scene, key, prop, a: leftValue, b: rightValue });
        }
      }
    }
  }
  return result;
}

async function compare(files, options) {
  if (files.length !== 2) throw new Error("compare requires exactly two files: compare <a.json> <b.json>");
  const limit = Number(options.get("limit") ?? 40);
  if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
  const [a, b] = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8"))));

  const result = compareRecordings(a, b);
  const byProp = new Map();
  for (const change of result.changes) byProp.set(change.prop, (byProp.get(change.prop) ?? 0) + 1);
  const total = result.changes.length
    + result.keysOnlyA.length
    + result.keysOnlyB.length
    + result.scenesOnlyA.length
    + result.scenesOnlyB.length;

  console.log(`a: ${files[0]} (${Object.keys(a.scenes).length} scene entries)`);
  console.log(`b: ${files[1]} (${Object.keys(b.scenes).length} scene entries)`);
  console.log(`scene entries compared: ${result.scenesCompared}`);
  console.log(`scene entries only in a: ${result.scenesOnlyA.length}`);
  for (const scene of result.scenesOnlyA.slice(0, limit)) console.log(`  ${scene}`);
  console.log(`scene entries only in b: ${result.scenesOnlyB.length}`);
  for (const scene of result.scenesOnlyB.slice(0, limit)) console.log(`  ${scene}`);
  console.log(`element keys only in a: ${result.keysOnlyA.length}`);
  for (const item of result.keysOnlyA.slice(0, limit)) console.log(`  ${item.scene} | ${item.key}`);
  console.log(`element keys only in b: ${result.keysOnlyB.length}`);
  for (const item of result.keysOnlyB.slice(0, limit)) console.log(`  ${item.scene} | ${item.key}`);
  console.log(`changed values: ${result.changes.length}`);
  console.log(`total differences: ${total}`);
  if (byProp.size > 0) {
    console.log("changes by property:");
    const sorted = [...byProp.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
    for (const [prop, count] of sorted) console.log(`  ${prop}: ${count}`);
  }
  if (result.changes.length > 0) {
    console.log(`first ${Math.min(limit, result.changes.length)} changes (scene | key | prop | a -> b):`);
    for (const change of result.changes.slice(0, limit)) {
      console.log(`  ${change.scene} | ${change.key} | ${change.prop} | ${change.a} -> ${change.b}`);
    }
  }
  process.exitCode = total === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const positional = [];
  const options = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const [key, inlineValue] = argument.slice(2).split(/=(.*)/s, 2);
    let value = inlineValue;
    if (value === undefined && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      value = argv[i + 1];
      i += 1;
    }
    options.set(key, value ?? true);
  }
  return { positional, options };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, options } = parseArguments(rest);
  if (command === "capture") {
    await capture(options);
  } else if (command === "compare") {
    await compare(positional, options);
  } else {
    throw new Error(
      "Usage:\n  node scripts/theme-snapshot.mjs capture --url <url> --out <file.json> [--themes a,b] [--scenes x,y] [--skin-map id=skin,...]\n  node scripts/theme-snapshot.mjs compare <a.json> <b.json> [--limit 40]",
    );
  }
}

main().catch((error) => {
  console.error(`[theme-snapshot] ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
