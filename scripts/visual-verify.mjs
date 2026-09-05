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
const secondaryInteractionWaitMs = 180;
const secondarySurfaceDefinitions = {
  drawer: { group: "A", expectedSelector: '.drawer[role="dialog"]' },
  "role-manager": { group: "A", expectedSelector: ".role-manager-dialog" },
  "role-switch": { group: "A", expectedSelector: ".conversation-role-dialog" },
  directory: { group: "A", expectedSelector: ".directory-browser-modal" },
  auth: { group: "A", expectedSelector: '[role="dialog"][aria-label]' },
  extension: { group: "A", expectedSelector: ".extension-modal" },
  feedback: {
    group: "A",
    expectedSelector: ".toast-stack",
    additionalSelectors: [".transition-status-overlay"],
  },
  "context-tooltip": {
    group: "A",
    expectedSelector: ".context-stat",
    additionalSelectors: ['.token-tooltip[role="tooltip"]'],
  },
  "commitment-expanded": {
    group: "A",
    expectedSelector: ".commitment-card",
    additionalSelectors: [".commitment-card .tool-text"],
  },
  setup: {
    group: "B",
    expectedSelector: ".workspace-setup-dialog",
    fallbackSelector: ".setup-card",
    requiresForm: true,
  },
  "role-selection": { group: "B", expectedSelector: ".role-selection-page" },
  empty: {
    group: "B",
    expectedSelector: ".workspace-placeholder",
    expectedHeading: "还没有打开工作区",
  },
  opening: {
    group: "B",
    expectedSelector: ".workspace-placeholder",
    expectedHeading: "正在打开工作区",
  },
  unavailable: {
    group: "B",
    expectedSelector: ".workspace-placeholder",
    expectedHeading: "工作区不可用",
  },
  "error-boundary": {
    group: "B",
    expectedSelector: '.setup-card[role="alert"]',
    expectedHeading: "页面出错了",
  },
};

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
const motionEvidence = args.has("motion");
const surfaceMode = args.has("surfaces");
const surfaceOption = args.get("surfaces");
const normalizedSurfaceOption = typeof surfaceOption === "string"
  ? surfaceOption.trim().toUpperCase()
  : "";
const requestedSurfaceGroup = normalizedSurfaceOption === "ALL"
  ? "all"
  : normalizedSurfaceOption;
let baseUrl = String(args.get("url") ?? "http://127.0.0.1:5173/");
if (visualFixture) {
  const fixtureUrl = new URL(baseUrl);
  fixtureUrl.searchParams.set("fixture", surfaceMode ? "secondary" : "workbench");
  baseUrl = fixtureUrl.toString();
}
const requestedViewport = args.get("viewport");
const viewports = requestedViewport
  ? [String(requestedViewport).split("x").map(Number)]
  : motionEvidence
    ? [[1440, 900]]
    : surfaceMode
      ? [[1920, 1080], [1440, 900], [390, 844]]
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

function secondarySurfaceSelector(surface) {
  return `[data-visual-fixture="secondary-surfaces"][data-visual-surface="${surface}"]`;
}

function secondarySurfaceUrl(surface) {
  const url = new URL(baseUrl);
  url.searchParams.set("surface", surface);
  return url.toString();
}

async function waitForSecondarySurface(client, surface) {
  const selector = secondarySurfaceSelector(surface);
  const deadline = Date.now() + Math.max(10_000, waitMs + 2_000);
  while (Date.now() < deadline) {
    const count = await client.evaluate(`document.querySelectorAll(${
      JSON.stringify(selector)
    }).length`);
    if (count === 1) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Secondary surface fixture was not ready: ${surface}`);
}

async function revealContextTooltip(client) {
  const pointer = await client.evaluate(`(() => {
    const anchor = document.querySelector(".context-stat");
    if (!anchor) return { issues: ["missing .context-stat before pointer interaction"] };
    const rect = anchor.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      useKeyboardFocus: innerWidth <= 600,
      issues: rect.width > 0 && rect.height > 0
        ? []
        : [".context-stat has no pointer target rect"],
    };
  })()`);
  if (pointer.issues.length > 0 || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
    throw new Error(`context-tooltip interaction failed: ${pointer.issues.join(", ")}`);
  }
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: pointer.x,
    y: pointer.y,
    button: "none",
    buttons: 0,
  });
  if (pointer.useKeyboardFocus) {
    await client.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await client.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await client.evaluate(`(() => {
      document.querySelector(".context-stat")?.focus({ preventScroll: true });
    })()`);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, secondaryInteractionWaitMs));

  const result = await client.evaluate(`(() => {
    const anchor = document.querySelector(".context-stat");
    const tooltip = document.querySelector('.token-tooltip[role="tooltip"]');
    const issues = [];
    if (!anchor) issues.push("missing .context-stat after pointer interaction");
    if (!tooltip) issues.push("missing .token-tooltip[role=tooltip] after pointer interaction");
    if (!anchor || !tooltip) return { issues };
    const anchorStyle = getComputedStyle(anchor);
    const tooltipStyle = getComputedStyle(tooltip);
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(tooltipRect.right, innerWidth) - Math.max(tooltipRect.left, 0));
    const visibleHeight = Math.max(0, Math.min(tooltipRect.bottom, innerHeight) - Math.max(tooltipRect.top, 0));
    const clippingAncestors = [];
    for (let ancestor = tooltip.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clips = [style.overflow, style.overflowX, style.overflowY]
        .some((value) => ["hidden", "clip", "scroll", "auto", "overlay"].includes(value));
      if (!clips) continue;
      const rect = ancestor.getBoundingClientRect();
      if (tooltipRect.left < rect.left - 1 || tooltipRect.right > rect.right + 1
        || tooltipRect.top < rect.top - 1 || tooltipRect.bottom > rect.bottom + 1) {
        clippingAncestors.push(ancestor.className || ancestor.tagName);
      }
    }
    const opacity = Number.parseFloat(tooltipStyle.opacity);
    const zIndex = Number.parseInt(tooltipStyle.zIndex, 10);
    if (!(opacity > 0) || tooltipStyle.visibility === "hidden" || tooltipStyle.display === "none") {
      issues.push("tooltip is not visibly revealed");
    }
    if (!Number.isFinite(zIndex) || zIndex < 1) {
      issues.push("tooltip has no effective stacking level");
    }
    if (tooltipRect.width <= 0 || tooltipRect.height <= 0) issues.push("tooltip has no visible rect");
    if (anchorRect.width <= 0 || anchorRect.height <= 0) issues.push("context stat has no visible anchor rect");
    if (tooltipRect.left < -1 || tooltipRect.right > innerWidth + 1
      || tooltipRect.top < -1 || tooltipRect.bottom > innerHeight + 1
      || visibleWidth < Math.min(16, tooltipRect.width)
      || visibleHeight < Math.min(16, tooltipRect.height)) {
      issues.push("tooltip is outside the viewport");
    }
    if (tooltipRect.bottom > anchorRect.top + 2 || tooltipRect.top >= anchorRect.top) {
      issues.push("tooltip is not above .context-stat");
    }
    if (Math.abs(tooltipRect.left - anchorRect.left) > 6) {
      issues.push("tooltip is not anchored to .context-stat");
    }
    if (clippingAncestors.length > 0) issues.push("tooltip is clipped by " + clippingAncestors.join(", "));
    return {
      issues,
      opacity,
      visibility: tooltipStyle.visibility,
      zIndex: tooltipStyle.zIndex,
      anchorRect: {
        left: anchorRect.left,
        top: anchorRect.top,
        right: anchorRect.right,
        bottom: anchorRect.bottom,
      },
      tooltipRect: {
        left: tooltipRect.left,
        top: tooltipRect.top,
        right: tooltipRect.right,
        bottom: tooltipRect.bottom,
      },
      anchorDisplay: anchorStyle.display,
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`context-tooltip interaction failed: ${result.issues.join(", ")}`);
  }
}

async function expandCommitmentCard(client) {
  const result = await client.evaluate(`(() => {
    const summary = document.querySelector(".commitment-card > summary");
    const issues = [];
    if (!summary) return { issues: ["missing .commitment-card > summary before click"] };
    const card = summary.parentElement;
    if (!card?.matches("details.commitment-card")) {
      return { issues: [".commitment-card > summary has no details parent"] };
    }
    summary.click();
    const toolText = card.querySelector(".tool-text");
    const text = toolText?.textContent?.trim() ?? "";
    if (!card.open) issues.push("commitment details did not open after summary click");
    if (!toolText) issues.push("missing .commitment-card .tool-text after expansion");
    if (text.length < 120 || text.split(/\\r?\\n/).length < 3) {
      issues.push("expanded commitment content is not long multiline text");
    }
    if (toolText && toolText.scrollHeight <= toolText.clientHeight + 1) {
      issues.push("expanded commitment text has no internal overflow boundary");
    }
    const transcript = document.querySelector(".transcript");
    if (!transcript) {
      issues.push("missing .transcript scroll owner");
    } else if (transcript.scrollHeight <= transcript.clientHeight) {
      issues.push(".transcript has no meaningful scrolling boundary");
    }
    card.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
    const cardRect = card.getBoundingClientRect();
    const summaryRect = summary.getBoundingClientRect();
    const textRect = toolText?.getBoundingClientRect();
    const composerRect = document.querySelector(".composer")?.getBoundingClientRect();
    const safeBottom = Math.min(innerHeight, composerRect?.top ?? innerHeight);
    if (summaryRect.top < -1 || summaryRect.bottom > safeBottom + 1) {
      issues.push("commitment disclosure is not visible above the composer");
    }
    if (!textRect || textRect.bottom <= 0 || textRect.top >= safeBottom) {
      issues.push("expanded commitment content is not visible above the composer");
    }
    if (cardRect.right <= 0 || cardRect.left >= innerWidth || cardRect.bottom <= 0 || cardRect.top >= innerHeight) {
      issues.push("expanded commitment card is outside the viewport");
    }
    return {
      issues,
      open: card.open,
      textLength: text.length,
      textScrollHeight: toolText?.scrollHeight ?? null,
      textClientHeight: toolText?.clientHeight ?? null,
      scrollHeight: transcript?.scrollHeight ?? null,
      clientHeight: transcript?.clientHeight ?? null,
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`commitment-expanded interaction failed: ${result.issues.join(", ")}`);
  }
}

async function inspectSecondarySurface(client, surface) {
  const selector = secondarySurfaceSelector(surface.surface);
  const expectedSelector = surface.expectedSelector;
  const fallbackSelector = surface.fallbackSelector ?? null;
  const additionalSelectors = surface.additionalSelectors ?? [];
  const expectedHeading = surface.expectedHeading ?? null;
  const result = await client.evaluate(`(() => {
    const rootSelector = ${JSON.stringify(selector)};
    const expectedSelector = ${JSON.stringify(expectedSelector)};
    const fallbackSelector = ${JSON.stringify(fallbackSelector)};
    const additionalSelectors = ${JSON.stringify(additionalSelectors)};
    const expectedGroup = ${JSON.stringify(surface.group)};
    const expectedHeading = ${JSON.stringify(expectedHeading)};
    const roots = [...document.querySelectorAll(rootSelector)];
    const fixtureRoots = [...document.querySelectorAll(
      '[data-visual-fixture="secondary-surfaces"]',
    )];
    const issues = [];
    const fixture = fixtureRoots[0];
    if (fixtureRoots.length !== 1) {
      issues.push("expected exactly one fixture root, found " + fixtureRoots.length);
    }
    if (roots.length !== 1 || roots[0] !== fixture) {
      issues.push("fixture surface does not match " + expectedSelector);
    }
    if (!fixture) {
      return { issues };
    }
    if (fixture.getAttribute("data-visual-group") !== expectedGroup) {
      issues.push("fixture group does not match " + expectedGroup);
    }
    const fixtureErrorMarker = document.querySelector(
      "[data-visual-fixture-error], [data-visual-error], [data-fixture-error], .visual-fixture-error",
    );
    const fixtureText = fixture.textContent ?? "";
    const fixtureErrorText = fixtureText.includes("未知的次级界面样本")
      || /(?:visual\\s+)?fixture[^\\n]{0,32}(?:error|failed|failure|错误|失败)|(?:error|failed|failure|错误|失败)[^\\n]{0,32}(?:visual\\s+)?fixture/i.test(fixtureText);
    const expectedBoundaryError = ${JSON.stringify(surface.surface)} === "error-boundary"
      && fixtureText.includes("Secondary surface fixture render failure");
    if (fixtureErrorMarker || (fixtureErrorText && !expectedBoundaryError)) {
      issues.push("fixture error marker/text present");
    }

    let primary = fixture.querySelector(expectedSelector);
    let resolvedSelector = expectedSelector;
    if (!primary && fallbackSelector) {
      primary = fixture.querySelector(fallbackSelector);
      resolvedSelector = fallbackSelector;
    }
    if (!primary) issues.push("missing " + expectedSelector);
    if (primary && ${JSON.stringify(surface.surface)} === "auth"
      && !primary.getAttribute("aria-label")?.trim()) {
      issues.push("auth dialog has no aria-label");
    }
    const motionRoots = [];
    const addMotionRoot = (element) => {
      if (!element || motionRoots.some((root) => root.contains(element))) return;
      for (let index = motionRoots.length - 1; index >= 0; index -= 1) {
        if (element.contains(motionRoots[index])) motionRoots.splice(index, 1);
      }
      motionRoots.push(element);
    };
    addMotionRoot(primary);
    for (const requiredSelector of additionalSelectors) {
      const matches = [...fixture.querySelectorAll(requiredSelector)];
      if (matches.length === 0) issues.push("missing " + requiredSelector);
      matches.forEach(addMotionRoot);
    }
    if (primary && expectedHeading) {
      const heading = primary.querySelector("h1, h2");
      if (!heading?.textContent?.includes(expectedHeading)) {
        issues.push("heading does not contain " + expectedHeading);
      }
    }
    if (primary && ${Boolean(surface.requiresForm)}) {
      if (!primary.matches("form") && !primary.querySelector("form")) {
        issues.push("setup surface has no form");
      }
    }
    if (primary) {
      const rect = primary.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      if (rect.width <= 0 || rect.height <= 0
        || visibleWidth < Math.min(16, rect.width)
        || visibleHeight < Math.min(16, rect.height)) {
        issues.push("primary surface is not visible enough in the viewport");
      }
    }

    const html = document.documentElement;
    const body = document.body;
    const overflow = Math.max(html.scrollWidth, body?.scrollWidth ?? 0) > innerWidth + 1;
    if (overflow) issues.push("document has horizontal overflow");
    const elements = [...new Set(motionRoots.flatMap((root) => [
      root,
      ...root.querySelectorAll("*"),
    ]))];
    const animationNames = new Set();
    const timingIssues = [];
    const hasNonZeroDuration = (value) => value.split(",").some((part) => {
      const duration = Number.parseFloat(part);
      return Number.isFinite(duration) && duration > 0;
    });
    for (const element of elements) {
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(element, pseudo);
        for (const name of style.animationName.split(",")) {
          if (name.trim() && name.trim() !== "none") animationNames.add(name.trim());
        }
        if (hasNonZeroDuration(style.transitionDuration)
          || hasNonZeroDuration(style.animationDuration)) {
          timingIssues.push({
            pseudo,
            transitionDuration: style.transitionDuration,
            animationDuration: style.animationDuration,
          });
        }
      }
    }
    const activeAnimations = [...new Set(motionRoots.flatMap((root) => root
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState !== "finished" && animation.playState !== "idle")))];
    const dialog = fixture.querySelector('[role="dialog"]');
    const appRoot = fixture.querySelector(".workbench, .role-selection-page, .setup-shell")
      ?? primary;
    return {
      title: document.title,
      issues,
      expectedSelector: resolvedSelector,
      appRoot: typeof appRoot?.className === "string"
        ? appRoot.className || appRoot.tagName.toLowerCase()
        : appRoot?.tagName.toLowerCase() ?? null,
      dialog: dialog?.getAttribute("aria-label") ?? null,
      overflow,
      animations: [...animationNames],
      activeAnimationCount: activeAnimations.length,
      timingIssues,
      document: {
        clientWidth: html.clientWidth,
        scrollWidth: html.scrollWidth,
        scrollHeight: html.scrollHeight,
      },
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`Secondary surface ${surface.surface} failed: ${result.issues.join(", ")}`);
  }
  if (reducedMotion && (result.activeAnimationCount > 0 || result.timingIssues.length > 0)) {
    throw new Error(`Secondary surface ${surface.surface} reduced-motion retained CSS timing`);
  }
  return result;
}

async function captureViewport(client, outputPath, width, height, index, surface = null) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 600,
  });
  await client.call("Page.navigate", {
    url: surface ? secondarySurfaceUrl(surface.surface) : baseUrl,
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));

  let diagnostics;
  if (surfaceMode) {
    await waitForSecondarySurface(client, surface.surface);
    if (["context-tooltip", "commitment-expanded"].includes(surface.surface)) {
      const collapsedMobileSidebar = await client.evaluate(`(() => {
        if (innerWidth > 600) return false;
        const toggle = document.querySelector(".conversation-sidebar-toggle");
        if (toggle?.getAttribute("aria-expanded") !== "true") return false;
        toggle.click();
        return true;
      })()`);
      if (collapsedMobileSidebar) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, secondaryInteractionWaitMs));
      }
    }
    if (surface.surface === "context-tooltip") await revealContextTooltip(client);
    if (surface.surface === "commitment-expanded") await expandCommitmentCard(client);
    diagnostics = await inspectSecondarySurface(client, surface);
  } else if (visualFixture) {
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
      const shellSelectors = [
        '.topbar',
        '.topbar-conversation-context',
        '.model-button',
        ...(innerWidth >= 1200 ? ['.brand', '.topbar-conversation-status'] : []),
      ];
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
        ...shellSelectors,
        ...(innerWidth > 600 ? ['.compaction-marker', '.message.user'] : []),
        '.assistant-activity-group.is-active',
        '.commitment-card',
        ...(missionVisible
          ? [
            '.mission-command',
            '.mission-objective-list',
            '.mission-context',
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
      for (const selector of [...shellSelectors, ...commandSelectors]) {
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
      if (innerWidth >= 1200) {
        const brandRect = document.querySelector('.brand')?.getBoundingClientRect();
        const contextRect = document.querySelector('.topbar-conversation-context')
          ?.getBoundingClientRect();
        const controlsRect = document.querySelector('.topbar-controls')
          ?.getBoundingClientRect();
        const copyRect = document.querySelector('.topbar-conversation-copy')
          ?.getBoundingClientRect();
        if (brandRect && contextRect && brandRect.right > contextRect.left + 1) {
          issues.push('.topbar (project/context overlap)');
        }
        if (contextRect && controlsRect && contextRect.right > controlsRect.left + 1) {
          issues.push('.topbar (context/model overlap)');
        }
        if (copyRect && copyRect.width < 180) {
          issues.push('.topbar-conversation-copy (narrow)');
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

  diagnostics ??= JSON.parse(
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
  const name = surface
    ? `${String(index + 1).padStart(2, "0")}-${surface.group}-${surface.surface}-${width}x${height}${reducedMotion ? "-reduced" : ""}.png`
    : `${String(index + 1).padStart(2, "0")}-${width}x${height}${visualFixture ? "-fixture" : ""}${reducedMotion ? "-reduced" : ""}.png`;
  await writeFile(join(outputPath, name), Buffer.from(screenshot.data, "base64"));
  return surface
    ? {
      name,
      group: surface.group,
      surface: surface.surface,
      viewport: [width, height],
      reducedMotion,
      appRoot: diagnostics.appRoot,
      dialog: diagnostics.dialog,
      overflow: diagnostics.overflow,
      animations: diagnostics.animations,
      expectedSelector: diagnostics.expectedSelector,
    }
    : { name, ...diagnostics };
}

function sameLayout(left, right) {
  return ["offsetLeft", "offsetTop", "offsetWidth", "offsetHeight"]
    .every((key) => left[key] === right[key]);
}

function assertMotionCase(name, frames, expectedDuration, reduced) {
  if (frames.some((frame) => frame.state.overflow)) {
    throw new Error(`${name} motion introduced horizontal overflow`);
  }
  if (!frames.slice(1).every((frame) => sameLayout(frames[0].state.layout, frame.state.layout))) {
    throw new Error(`${name} motion changed layout geometry`);
  }
  if (frames.at(-1).state.activeMotions.length > 0) {
    throw new Error(`${name} motion remained active after settling`);
  }
  const observed = frames.flatMap((frame) => frame.state.activeMotions);
  const completed = frames.at(-1).completedMotions ?? [];
  if (reduced) {
    if (observed.length > 0) throw new Error(`${name} reduced-motion path still animated`);
    if (frames.some((frame) => frame.state.transitionProperty !== "none"
      || frame.state.transitionDuration !== "0s"
      || frame.state.animationName !== "none"
      || frame.state.animationDuration !== "0s")) {
      throw new Error(`${name} reduced-motion path retained CSS timing`);
    }
    return;
  }
  if (!observed.some((motion) => Math.abs(motion.durationMs - expectedDuration) < 0.5)) {
    throw new Error(`${name} did not expose its ${expectedDuration}ms motion token`);
  }
  if (completed.length === 0
    || completed.some((motion) => !Number.isFinite(motion.iterations))) {
    throw new Error(`${name} did not naturally finish a finite motion`);
  }
  const layoutProperties = new Set([
    "blockSize",
    "bottom",
    "height",
    "inlineSize",
    "left",
    "margin",
    "padding",
    "right",
    "top",
    "width",
  ]);
  const animatedLayoutProperty = observed
    .flatMap((motion) => motion.properties)
    .find((property) => layoutProperties.has(property));
  if (animatedLayoutProperty) {
    throw new Error(`${name} animated layout property ${animatedLayoutProperty}`);
  }
}

async function readMotionState(
  client,
  selector,
  pseudo = null,
  styleSelector = selector,
) {
  return client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const styleElement = document.querySelector(${JSON.stringify(styleSelector)});
    if (!element || !styleElement) {
      throw new Error('Motion target missing: ' + ${JSON.stringify(selector)});
    }
    const style = getComputedStyle(styleElement, ${JSON.stringify(pseudo)});
    const motionDetails = (animation) => {
      const effect = animation.effect;
      const timing = effect?.getTiming();
      const keyframes = effect?.getKeyframes() ?? [];
      const ignored = new Set(['offset', 'computedOffset', 'easing', 'composite']);
      return {
        type: animation.constructor.name,
        name: animation.animationName ?? null,
        property: animation.transitionProperty ?? null,
        durationMs: typeof timing?.duration === 'number' ? timing.duration : null,
        easing: timing?.easing ?? null,
        playState: animation.playState,
        properties: [...new Set(keyframes.flatMap((keyframe) =>
          Object.keys(keyframe).filter((key) => !ignored.has(key))))],
      };
    };
    return {
      layout: {
        offsetLeft: element.offsetLeft,
        offsetTop: element.offsetTop,
        offsetWidth: element.offsetWidth,
        offsetHeight: element.offsetHeight,
      },
      visualRect: (() => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      })(),
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
      transitionTimingFunction: style.transitionTimingFunction,
      animationDuration: style.animationDuration,
      animationName: style.animationName,
      animationTimingFunction: style.animationTimingFunction,
      visualStyle: {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        color: style.color,
        opacity: style.opacity,
        transform: style.transform,
      },
      activeMotions: element.getAnimations({ subtree: true })
        .filter((animation) => animation.playState !== 'finished'
          && animation.playState !== 'idle')
        .map(motionDetails),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      workbenchColumns: getComputedStyle(document.querySelector('.workbench'))
        .gridTemplateColumns,
      expanded: element.getAttribute('aria-expanded'),
      membersPresent: !!element.closest('.conversation-group-card')
        ?.querySelector('.conversation-group-members'),
    };
  })()`);
}

async function captureMotionFrame(
  client,
  outputPath,
  name,
  regionSelector,
  stateSelector,
  pseudo = null,
  styleSelector = stateSelector,
) {
  const clip = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(regionSelector)});
    if (!element) throw new Error('Motion capture region missing: '
      + ${JSON.stringify(regionSelector)});
    const rect = element.getBoundingClientRect();
    const padding = 12;
    const x = Math.max(0, Math.floor(rect.left - padding));
    const y = Math.max(0, Math.floor(rect.top - padding));
    const right = Math.min(innerWidth, Math.ceil(rect.right + padding));
    const bottom = Math.min(innerHeight, Math.ceil(rect.bottom + padding));
    return { x, y, width: right - x, height: bottom - y, scale: 1 };
  })()`);
  const screenshot = await client.call("Page.captureScreenshot", {
    format: "png",
    clip,
    captureBeyondViewport: false,
  });
  await writeFile(join(outputPath, name), Buffer.from(screenshot.data, "base64"));
  return {
    name,
    clip,
    state: await readMotionState(client, stateSelector, pseudo, styleSelector),
  };
}

async function seekMotion(client, selector, progress) {
  await client.evaluate(`(async () => {
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Motion target missing: ' + ${JSON.stringify(selector)});
    element.getAnimations({ subtree: true }).forEach((animation) => {
      const duration = animation.effect?.getTiming().duration;
      animation.pause();
      animation.currentTime = typeof duration === 'number' ? duration * ${progress} : 0;
    });
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
  })()`);
}

async function finishMotion(client, selector) {
  return client.evaluate(`(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Motion target missing: ' + ${JSON.stringify(selector)});
    const animations = element.getAnimations({ subtree: true });
    const completed = animations.map((animation) => {
      const timing = animation.effect?.getTiming();
      return {
        type: animation.constructor.name,
        name: animation.animationName ?? null,
        property: animation.transitionProperty ?? null,
        durationMs: typeof timing?.duration === 'number' ? timing.duration : null,
        iterations: timing?.iterations ?? 1,
        fill: timing?.fill ?? 'auto',
      };
    });
    animations.forEach((animation) => animation.finish());
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
    return completed;
  })()`);
}

async function cancelMotion(client, selector) {
  await client.evaluate(`(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
  })()`);
}

async function forcePseudoState(client, selector, states) {
  const { root } = await client.call("DOM.getDocument", { depth: 0 });
  const { nodeId } = await client.call("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`Motion target missing: ${selector}`);
  await client.call("CSS.forcePseudoState", {
    nodeId,
    forcedPseudoClasses: states,
  });
  return nodeId;
}

async function captureMotionEvidence(client, outputPath, width, height) {
  const cases = [];

  const punchSelector = ".app-shell .model-button";
  const punchFrames = [await captureMotionFrame(
    client,
    outputPath,
    "motion-punch-01-start.png",
    ".topbar-controls",
    punchSelector,
  )];
  const punchNodeId = await forcePseudoState(client, punchSelector, ["hover", "active"]);
  if (!reducedMotion) await seekMotion(client, punchSelector, 0.5);
  punchFrames.push(await captureMotionFrame(
    client,
    outputPath,
    `motion-punch-02-${reducedMotion ? "instant" : "mid"}.png`,
    ".topbar-controls",
    punchSelector,
  ));
  const punchCompletion = await finishMotion(client, punchSelector);
  punchFrames.push({
    ...(await captureMotionFrame(
      client,
      outputPath,
      "motion-punch-03-settled.png",
      ".topbar-controls",
      punchSelector,
    )),
    completedMotions: punchCompletion,
  });
  assertMotionCase("PUNCH", punchFrames, 110, reducedMotion);
  await client.call("CSS.forcePseudoState", {
    nodeId: punchNodeId,
    forcedPseudoClasses: [],
  });
  await cancelMotion(client, punchSelector);
  cases.push({
    name: "PUNCH",
    trigger: "model access :active",
    frames: punchFrames,
  });

  const slashSelector = ".conversation-group-disclosure";
  await client.evaluate(`(async () => {
    const disclosure = document.querySelector(${JSON.stringify(slashSelector)});
    if (!disclosure) throw new Error('SLASH disclosure missing');
    if (disclosure.getAttribute('aria-expanded') !== 'false') disclosure.click();
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
  })()`);
  await cancelMotion(client, slashSelector);
  const slashFrames = [await captureMotionFrame(
    client,
    outputPath,
    "motion-slash-01-start.png",
    ".conversation-sidebar",
    slashSelector,
    "::before",
    ".conversation-group-chevron",
  )];
  await client.evaluate(`(async () => {
    document.querySelector(${JSON.stringify(slashSelector)})?.click();
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
  })()`);
  if (!reducedMotion) await seekMotion(client, slashSelector, 0.5);
  slashFrames.push(await captureMotionFrame(
    client,
    outputPath,
    `motion-slash-02-${reducedMotion ? "instant" : "mid"}.png`,
    ".conversation-sidebar",
    slashSelector,
    "::before",
    ".conversation-group-chevron",
  ));
  if (slashFrames[1].state.expanded !== "true" || !slashFrames[1].state.membersPresent) {
    throw new Error("SLASH delayed the expanded state or member DOM");
  }
  const slashCompletion = await finishMotion(client, slashSelector);
  slashFrames.push({
    ...(await captureMotionFrame(
      client,
      outputPath,
      "motion-slash-03-settled.png",
      ".conversation-sidebar",
      slashSelector,
      "::before",
      ".conversation-group-chevron",
    )),
    completedMotions: slashCompletion,
  });
  assertMotionCase("SLASH", slashFrames, 150, reducedMotion);
  await cancelMotion(client, slashSelector);
  cases.push({
    name: "SLASH",
    trigger: "conversation group expand",
    frames: slashFrames,
  });

  const stampSelector = ".transcript .compaction-state";
  const stampFrames = [await captureMotionFrame(
    client,
    outputPath,
    "motion-stamp-01-start.png",
    ".compaction-marker",
    stampSelector,
    "::after",
  )];
  await client.evaluate(`(async () => {
    const element = document.querySelector(${JSON.stringify(stampSelector)});
    if (!element) throw new Error('STAMP target missing');
    element.classList.remove('compaction-state');
    void element.offsetWidth;
    element.classList.add('compaction-state');
    await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
  })()`);
  if (!reducedMotion) await seekMotion(client, stampSelector, 0.5);
  stampFrames.push(await captureMotionFrame(
    client,
    outputPath,
    `motion-stamp-02-${reducedMotion ? "instant" : "mid"}.png`,
    ".compaction-marker",
    stampSelector,
    "::after",
  ));
  const stampCompletion = await finishMotion(client, stampSelector);
  stampFrames.push({
    ...(await captureMotionFrame(
      client,
      outputPath,
      "motion-stamp-03-settled.png",
      ".compaction-marker",
      stampSelector,
      "::after",
    )),
    completedMotions: stampCompletion,
  });
  assertMotionCase("STAMP", stampFrames, 130, reducedMotion);
  if (["opacity", "transform"].some((property) =>
    stampFrames[0].state.visualStyle[property]
      !== stampFrames[2].state.visualStyle[property])) {
    throw new Error("STAMP retained a visual effect after completion");
  }
  await cancelMotion(client, stampSelector);
  cases.push({
    name: "STAMP",
    trigger: "terminal compaction DONE state",
    frames: stampFrames,
  });

  return {
    viewport: [width, height],
    reducedMotion,
    cases,
  };
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
  if (surfaceMode && !visualFixture) throw new Error("--surfaces requires --fixture");
  if (motionEvidence && !visualFixture) throw new Error("--motion requires --fixture");
  if (surfaceMode && (surfaceOption === true
    || typeof surfaceOption !== "string"
    || surfaceOption.trim() === "")) {
    throw new Error("--surfaces requires a value");
  }
  if (surfaceMode && !["A", "B", "ALL"].includes(normalizedSurfaceOption)) {
    throw new Error("--surfaces must be A, B, or all");
  }
  if (surfaceMode && motionEvidence) {
    throw new Error("--surfaces cannot be combined with --motion");
  }
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
    if (motionEvidence) {
      await client.call("DOM.enable");
      await client.call("CSS.enable");
      await client.call("Animation.enable");
    }
    if (reducedMotion) {
      await client.call("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
    }

    const captures = [];
    if (surfaceMode) {
      const surfaceNames = Object.entries(secondarySurfaceDefinitions)
        .filter(([, definition]) => normalizedSurfaceOption === "ALL"
          || definition.group === normalizedSurfaceOption)
        .map(([surfaceName]) => surfaceName);
      let index = 0;
      for (const surfaceName of surfaceNames) {
        const surface = {
          surface: surfaceName,
          ...secondarySurfaceDefinitions[surfaceName],
        };
        for (const viewport of viewports) {
          captures.push(await captureViewport(
            client,
            runDir,
            viewport[0],
            viewport[1],
            index,
            surface,
          ));
          index += 1;
        }
      }
    } else {
      for (const [index, viewport] of viewports.entries()) {
        captures.push(await captureViewport(client, runDir, viewport[0], viewport[1], index));
      }
    }
    let motion = null;
    if (motionEvidence) {
      await client.call("Animation.setPlaybackRate", { playbackRate: 0.05 });
      try {
        const [width, height] = viewports.at(-1);
        motion = await captureMotionEvidence(client, runDir, width, height);
      } finally {
        await client.call("Animation.setPlaybackRate", { playbackRate: 1 });
      }
    }
    const setupFlow = visualFixture ? null : await checkSetupFlow(client);
    client.close();

    const manifest = {
      generatedAt: new Date().toISOString(),
      url: baseUrl,
      browser,
      reducedMotion,
      ...(visualFixture
        ? surfaceMode
          ? { fixture: "secondary", surfaceGroup: requestedSurfaceGroup }
          : { fixture: "workbench" }
        : {}),
      captures,
      ...(motion ? { motion } : {}),
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
