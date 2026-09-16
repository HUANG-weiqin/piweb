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
const ledgerViewports = [
  [3440, 1440],
  [1920, 1080],
  [1440, 900],
  [960, 900],
  [390, 844],
  [390, 600],
];
const jumpViewports = [[1440, 900], [390, 844], [390, 600]];
const settingsViewports = [[1440, 900], [390, 844], [320, 600]];
const secondarySurfaceDefinitions = {
  drawer: {
    group: "A",
    expectedSelector: '.drawer[role="dialog"][data-settings-route="home"]',
    viewports: settingsViewports,
  },
  "drawer-appearance": {
    group: "A",
    expectedSelector: '.drawer[role="dialog"][data-settings-route="appearance"]',
    viewports: settingsViewports,
  },
  "drawer-model-connections": {
    group: "A",
    expectedSelector: '.drawer[role="dialog"][data-settings-route="model-connections"]',
    viewports: settingsViewports,
  },
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
  "activity-expanded": {
    group: "A",
    expectedSelector: ".assistant-activity-group.is-active",
    additionalSelectors: [".assistant-activity-group.is-active .activity-timeline", ".assistant-activity-group.is-active .tool-text"],
    viewports: ledgerViewports,
  },
  "commitment-expanded": {
    group: "A",
    expectedSelector: ".commitment-card",
    additionalSelectors: [".commitment-card .tool-text"],
    viewports: ledgerViewports,
  },
  "jump-latest": {
    group: "A",
    expectedSelector: ".jump-latest",
    viewports: jumpViewports,
  },
  "jump-latest-focus": {
    group: "A",
    expectedSelector: ".jump-latest",
    viewports: jumpViewports,
  },
  "composer-states": {
    group: "A",
    expectedSelector: ".composer-wrap",
    additionalSelectors: [".pending-admissions", ".loop-list-items", ".composer-notice"],
    viewports: [[960, 900], [390, 844], [390, 600]],
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
const normalizedSurfaceName = typeof surfaceOption === "string"
  ? surfaceOption.trim()
  : "";
const normalizedSurfaceOption = normalizedSurfaceName.toUpperCase();
const requestedSurfaceName = Object.hasOwn(
  secondarySurfaceDefinitions,
  normalizedSurfaceName,
)
  ? normalizedSurfaceName
  : undefined;
const requestedSurfaceGroup = requestedSurfaceName
  ?? (normalizedSurfaceOption === "ALL" ? "all" : normalizedSurfaceOption);
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

function waitForSecondaryInteraction() {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, secondaryInteractionWaitMs));
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
  await waitForSecondaryInteraction();

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

async function expandCommitmentCard(client, evidencePath = null, evidenceName = null) {
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
    if (!transcript) issues.push("missing .transcript scroll owner");
    card.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
    const cardRect = card.getBoundingClientRect();
    const summaryRect = summary.getBoundingClientRect();
    const textRect = toolText?.getBoundingClientRect();
    const body = card.querySelector(":scope > .tool-body");
    const cardStyle = getComputedStyle(card);
    const bodyPaddingLeft = body ? Number.parseFloat(getComputedStyle(body).paddingLeft) : NaN;
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
    if (cardStyle.overflow !== "visible" || cardStyle.clipPath !== "none") {
      issues.push("expanded commitment card retains a clipping boundary");
    }
    if (!Number.isFinite(bodyPaddingLeft)
      || (innerWidth > 600 && bodyPaddingLeft < 120)
      || (innerWidth <= 600 && bodyPaddingLeft > 24)) {
      issues.push("expanded edit-budget details are not aligned for this viewport");
    }
    summary.focus({ preventScroll: true });
    if (document.activeElement !== summary) {
      issues.push("commitment summary is not keyboard focusable");
    }
    summary.blur();
    return {
      issues,
      open: card.open,
      textLength: text.length,
      textScrollHeight: toolText?.scrollHeight ?? null,
      textClientHeight: toolText?.clientHeight ?? null,
      bodyPaddingLeft,
      bodyRect: body ? (() => {
        const rect = body.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      })() : null,
      clipPath: cardStyle.clipPath,
      scrollHeight: transcript?.scrollHeight ?? null,
      clientHeight: transcript?.clientHeight ?? null,
    };
  })()`);
  if (result.issues.length > 0) {
    let evidence = "";
    if (evidencePath) {
      const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
      const name = evidenceName ?? "commitment-expanded-failure.png";
      await writeFile(join(evidencePath, name), Buffer.from(screenshot.data, "base64"));
      evidence = `; screenshot=${join(evidencePath, name)}`;
    }
    throw new Error(`commitment-expanded interaction failed: ${result.issues.join(", ")}; selector=.transcript .commitment-card.is-edit-budget > .tool-body; bodyPaddingLeft=${result.bodyPaddingLeft}; bodyRect=${JSON.stringify(result.bodyRect)}${evidence}`);
  }
  return result;
}

async function expandActivityLedger(client) {
  const opened = await client.evaluate(`(() => {
    const ledger = document.querySelector(".assistant-activity-group.is-active");
    if (!ledger?.matches("details")) return false;
    if (!ledger.open) ledger.querySelector(":scope > summary")?.click();
    const thinking = ledger.querySelector(".activity-timeline > details.thinking");
    if (!thinking?.matches("details")) return false;
    if (!thinking.open) thinking.querySelector(":scope > summary")?.click();
    const tools = ledger.querySelector(".activity-timeline > details.tools");
    if (!tools?.matches("details")) return false;
    if (!tools.open) tools.querySelector(":scope > summary")?.click();
    return true;
  })()`);
  if (!opened) throw new Error("activity-expanded could not open the activity and tool ledgers");
  await waitForSecondaryInteraction();
  await client.evaluate(`document.querySelector(
    ".assistant-activity-group.is-active .tool-toggle",
  )?.click()`);
  await waitForSecondaryInteraction();
  const outputOpened = await client.evaluate(`(() => {
    const tools = document.querySelector(
      ".assistant-activity-group.is-active .activity-timeline > details.tools",
    );
    const outputTool = [...(tools?.querySelectorAll("details.tool") ?? [])]
      .find((tool) => tool.querySelector(".tool-target")
        ?.textContent?.includes("Message.test.tsx"));
    if (!outputTool) return false;
    if (!outputTool.open) outputTool.querySelector(":scope > summary")?.click();
    return true;
  })()`);
  if (!outputOpened) throw new Error("activity-expanded could not open the long-output tool");
  await waitForSecondaryInteraction();
  const result = await client.evaluate(`(() => {
    const ledger = document.querySelector(".assistant-activity-group.is-active");
    const thinking = ledger?.querySelector(".activity-timeline > details.thinking");
    const thinkingBody = thinking?.querySelector(".thinking-body");
    const tools = ledger?.querySelector(".activity-timeline > details.tools");
    const toolCards = [...(tools?.querySelectorAll("details.tool") ?? [])];
    const outputTool = toolCards.find((tool) => tool.querySelector(".tool-target")
      ?.textContent?.includes("Message.test.tsx"));
    ledger?.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
    const text = outputTool?.querySelector(".tool-text");
    const ledgerRect = ledger?.getBoundingClientRect();
    const thinkingBodyRect = thinkingBody?.getBoundingClientRect();
    const transcript = document.querySelector(".transcript");
    const issues = [];
    if (!ledger?.open) issues.push("activity ledger did not open after summary click");
    if (!thinking?.open) issues.push("nested thinking ledger did not open after summary click");
    if (!thinkingBody || (thinkingBody.textContent?.trim().length ?? 0) < 120) {
      issues.push("thinking fixture is missing long markdown content");
    }
    if (!tools?.open) issues.push("nested tool ledger did not open after summary click");
    if (toolCards.length !== 7) issues.push("expected seven tool ledger rows, found " + toolCards.length);
    if (!outputTool?.open) issues.push("long-output tool did not open after summary click");
    if (!text) issues.push("missing long local tool output");
    if (text && text.scrollHeight <= text.clientHeight + 1) {
      issues.push("long tool output has no local scrolling boundary");
    }
    if (!transcript) issues.push("activity fixture is missing the transcript scroll owner");
    if (!ledgerRect || ledgerRect.left < -1 || ledgerRect.right > innerWidth + 1) {
      issues.push("expanded activity ledger crosses the viewport");
    }
    if (!thinkingBodyRect || !ledgerRect
      || thinkingBodyRect.left < ledgerRect.left - 1
      || thinkingBodyRect.right > ledgerRect.right + 1
      || (thinking && thinking.scrollWidth > thinking.clientWidth + 1)) {
      issues.push("expanded thinking content crosses the activity ledger");
    }
    return {
      issues,
      open: ledger?.open ?? false,
      thinkingOpen: thinking?.open ?? false,
      thinkingScrollWidth: thinking?.scrollWidth ?? null,
      thinkingClientWidth: thinking?.clientWidth ?? null,
      toolsOpen: tools?.open ?? false,
      toolCount: toolCards.length,
      outputOpen: outputTool?.open ?? false,
      outputScrollHeight: text?.scrollHeight ?? null,
      outputClientHeight: text?.clientHeight ?? null,
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`activity-expanded interaction failed: ${result.issues.join(", ")}`);
  }
  return result;
}

async function wheelTranscriptUp(client) {
  const pointer = await client.evaluate(`(() => {
    const transcript = document.querySelector(".transcript");
    if (!transcript) return { issues: ["missing transcript"] };
    transcript.scrollTop = transcript.scrollHeight;
    const rect = transcript.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + Math.min(50, rect.height * 0.1),
      before: transcript.scrollTop,
      deltaY: -Math.max(320, Math.round(transcript.clientHeight * 0.7)),
      issues: transcript.scrollHeight > transcript.clientHeight
        ? []
        : ["transcript has no scroll range"],
    };
  })()`);
  if (pointer.issues.length > 0) {
    throw new Error(`jump-latest wheel setup failed: ${pointer.issues.join(", ")}`);
  }
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: pointer.x,
    y: pointer.y,
    button: "none",
    buttons: 0,
  });
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: pointer.x,
    y: pointer.y,
    deltaX: 0,
    deltaY: pointer.deltaY,
  });
  await waitForSecondaryInteraction();
  const result = await client.evaluate(`(() => {
    const transcript = document.querySelector(".transcript");
    const jump = document.querySelector(".jump-latest");
    const issues = [];
    if (!transcript) return { issues: ["missing transcript after wheel"] };
    if (transcript.scrollTop >= ${JSON.stringify(pointer.before)} - 2) {
      issues.push("real upward wheel did not move the transcript");
    }
    if (!jump || jump.getClientRects().length === 0) {
      issues.push("jump-latest did not become visible after real wheel detach");
    }
    return {
      issues,
      scrollTop: transcript.scrollTop,
      distanceFromBottom: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`jump-latest wheel interaction failed: ${result.issues.join(", ")}`);
  }
  return result;
}

async function clickJumpLatest(client) {
  const pointer = await client.evaluate(`(() => {
    const jump = document.querySelector(".jump-latest");
    if (!jump) return { issues: ["missing jump-latest before pointer click"] };
    const rect = jump.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      issues: rect.width >= 44 && rect.height >= 44
        ? []
        : ["jump-latest pointer target is smaller than 44px"],
    };
  })()`);
  if (pointer.issues.length > 0) {
    throw new Error(`jump-latest pointer setup failed: ${pointer.issues.join(", ")}`);
  }
  await client.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: pointer.x,
    y: pointer.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: pointer.x,
    y: pointer.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await waitForSecondaryInteraction();
  const result = await client.evaluate(`(() => {
    const transcript = document.querySelector(".transcript");
    const distance = transcript
      ? transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop
      : Infinity;
    const issues = [];
    if (!transcript) issues.push("missing transcript after pointer click");
    if (distance > 2) issues.push("pointer click did not jump to the bottom");
    if (document.querySelector(".jump-latest")) {
      issues.push("jump-latest remained after reaching the bottom");
    }
    return { issues, distanceFromBottom: distance };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`jump-latest pointer interaction failed: ${result.issues.join(", ")}`);
  }
  return result;
}

async function exerciseJumpLatest(client, focusVisible) {
  const activity = await expandActivityLedger(client);
  const firstDetach = await wheelTranscriptUp(client);
  const pointerJump = await clickJumpLatest(client);
  const secondDetach = await wheelTranscriptUp(client);
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
  const focus = await client.evaluate(`(() => {
    const jump = document.querySelector(".jump-latest");
    if (${JSON.stringify(focusVisible)}) jump?.focus({ preventScroll: true });
    else jump?.blur();
    const rect = jump?.getBoundingClientRect();
    const focused = document.activeElement === jump;
    const focusVisible = jump?.matches(":focus-visible") ?? false;
    const issues = [];
    if (!jump || !rect || rect.width <= 0 || rect.height <= 0) {
      issues.push("jump-latest is not visible for capture");
    }
    if (rect && (rect.left < -1 || rect.right > innerWidth + 1
      || rect.top < -1 || rect.bottom > innerHeight + 1)) {
      issues.push("jump-latest crosses the viewport");
    }
    if (${JSON.stringify(focusVisible)} && (!focused || !focusVisible)) {
      issues.push("jump-latest did not retain keyboard-visible focus");
    }
    if (!${JSON.stringify(focusVisible)} && focused) {
      issues.push("normal jump-latest capture unexpectedly retained focus");
    }
    return { issues, focused, focusVisible };
  })()`);
  if (focus.issues.length > 0) {
    throw new Error(`jump-latest focus state failed: ${focus.issues.join(", ")}`);
  }
  return { activity, firstDetach, pointerJump, secondDetach, ...focus };
}

async function exerciseComposerStates(client, evidencePath = null, evidenceName = null) {
  await expandActivityLedger(client);
  const hasTasks = await client.evaluate(`(() => {
    const tasks = document.querySelector(".loop-list-toggle");
    if (!tasks) return false;
    if (tasks.getAttribute("aria-expanded") !== "true") tasks.click();
    return true;
  })()`);
  if (!hasTasks) throw new Error("composer-states is missing Tasks");
  await waitForSecondaryInteraction();
  const opened = await client.evaluate(`document.querySelector(
    ".loop-list-toggle",
  )?.getAttribute("aria-expanded") === "true"`);
  if (!opened) throw new Error("composer-states could not expand Tasks");
  const detached = await wheelTranscriptUp(client);
  await client.evaluate(`document.querySelector(".loop-list-toggle")?.click()`);
  await waitForSecondaryInteraction();
  await client.evaluate(`document.querySelector(".loop-list-toggle")?.click()`);
  await waitForSecondaryInteraction();
  const resized = await client.evaluate(`(() => {
    const transcript = document.querySelector(".transcript");
    const jump = document.querySelector(".jump-latest");
    const pending = document.querySelector(".pending-admissions")?.getBoundingClientRect();
    const tasks = document.querySelector(".loop-list")?.getBoundingClientRect();
    const notice = document.querySelector(".composer-notice")?.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    const issues = [];
    if (!jump) issues.push("composer resize reclaimed detached transcript");
    if (!document.querySelector(".loop-list-items")) issues.push("Tasks did not remain expanded");
    if (!pending || !tasks || !notice || !composer) {
      issues.push("composer state ledger is incomplete");
    } else {
      if (pending.bottom > tasks.top + 1) issues.push("pending admissions overlap Tasks");
      if (tasks.bottom > notice.top + 1) issues.push("Tasks overlap composer notice");
      if (notice.bottom > composer.top + 1) issues.push("composer notice overlaps composer");
      if (pending.top < -1 || composer.bottom > innerHeight + 1) {
        issues.push("composer state ledger crosses the viewport");
      }
    }
    const rectSnapshot = (rect) => rect ? {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    } : null;
    return {
      issues,
      distanceFromBottom: transcript
        ? transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop
        : null,
      geometry: {
        pending: rectSnapshot(pending),
        tasks: rectSnapshot(tasks),
        notice: rectSnapshot(notice),
        composer: rectSnapshot(composer),
      },
    };
  })()`);
  if (resized.issues.length > 0) {
    let evidence = "";
    if (evidencePath) {
      const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
      const name = evidenceName ?? "composer-states-failure.png";
      await writeFile(join(evidencePath, name), Buffer.from(screenshot.data, "base64"));
      evidence = `; screenshot=${join(evidencePath, name)}`;
    }
    throw new Error(`composer-states interaction failed: ${resized.issues.join(", ")}; geometry=${JSON.stringify(resized.geometry)}${evidence}`);
  }
  const pointerJump = await clickJumpLatest(client);
  return { detached, resized, pointerJump, tasksExpanded: true };
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

async function clickVisibleButton(client, selector) {
  const result = await client.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!(button instanceof HTMLButtonElement)) {
      return { issues: ["missing button " + ${JSON.stringify(selector)}] };
    }
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    if (button.hidden || style.display === "none" || style.visibility === "hidden"
      || button.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) {
      return { issues: ["button is not visible " + ${JSON.stringify(selector)}] };
    }
    if (button.disabled) {
      return { issues: ["button is disabled " + ${JSON.stringify(selector)}] };
    }
    return {
      issues: [],
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`Mobile button interaction failed: ${result.issues.join(", ")}`);
  }
  await client.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: result.x,
    y: result.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: result.x,
    y: result.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await waitForSecondaryInteraction();
}

async function inspectMobileScene(client, scene) {
  const result = await client.evaluate(`(() => {
    const scene = ${JSON.stringify(scene)};
    const issues = [];
    const roots = {
      workspaces: document.querySelector(".workspace-rail"),
      conversations: document.querySelector(".conversation-sidebar"),
      chat: document.querySelector(".workbench-main"),
    };
    const visible = (element) => {
      if (!element || element.hidden) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden"
        && element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
    };
    const rectOf = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const visibleRoots = Object.entries(roots)
      .filter(([, element]) => visible(element))
      .map(([name]) => name);
    const expectedRoots = [scene];
    if (visibleRoots.join("|") !== expectedRoots.join("|")) {
      issues.push("mobile scene roots were not mutually exclusive: " + visibleRoots.join(", "));
    }
    const rects = {};
    const checkVisible = (
      selector,
      label = selector,
      touch = false,
      withinViewport = true,
    ) => {
      const element = document.querySelector(selector);
      const rect = rectOf(element);
      rects[label] = rect;
      if (!element || !visible(element) || !rect) {
        issues.push(label + " is not visible");
        return;
      }
      if (withinViewport && (rect.left < -1 || rect.top < -1
        || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1)) {
        issues.push(label + " crosses the viewport");
      }
      if (touch && (rect.width < 44 || rect.height < 44)) {
        issues.push(label + " touch target is smaller than 44px");
      }
    };
    const checkHorizontal = (selector, label = selector) => {
      const element = document.querySelector(selector);
      const rect = rectOf(element);
      rects[label] = rect;
      if (!element || !visible(element) || !rect) {
        issues.push(label + " is not visible");
        return;
      }
      if (rect.left < -1 || rect.right > innerWidth + 1) {
        issues.push(label + " crosses the viewport horizontally");
      }
    };
    const requireFullWidth = (rect, label) => {
      if (!rect || rect.left > 1 || rect.right < innerWidth - 1 || rect.width < innerWidth * 0.9) {
        issues.push(label + " is not approximately full viewport width");
      }
    };
    const checkHidden = (name) => {
      if (visible(roots[name])) issues.push(name + " should be hidden");
    };
    for (const name of Object.keys(roots)) {
      if (name !== scene) checkHidden(name);
    }

    if (scene === "conversations") {
      checkVisible(".conversation-sidebar .mobile-page-header", "mobile list header");
      checkVisible(".conversation-sidebar-navigation", "conversation list");
      checkVisible(".conversation-sidebar-footer", "conversation list footer");
      checkVisible(".conversation-sidebar-create", "create conversation", true);
      checkVisible(".conversation-sidebar .mobile-page-header button[aria-label=\\"显示工作区\\"]", "show workspaces", true);
      checkVisible(".conversation-sidebar .mobile-page-header button[aria-label=\\"打开当前会话\\"]", "open current conversation", true);
      const header = rectOf(document.querySelector(".conversation-sidebar .mobile-page-header"));
      const list = rectOf(document.querySelector(".conversation-sidebar-navigation"));
      const footer = rectOf(document.querySelector(".conversation-sidebar-footer"));
      requireFullWidth(header, "mobile list header");
      requireFullWidth(list, "conversation list");
      requireFullWidth(footer, "conversation list footer");
      if (header && (header.height < 44 || header.height > innerHeight * 0.4)) {
        issues.push("mobile list header has an unreasonable height");
      }
      if (!header || !list || !footer
        || header.bottom > list.top + 1
        || list.bottom > footer.top + 1) {
        issues.push("conversation header, navigation, and footer are not vertically ordered");
      }
    }
    if (scene === "workspaces") {
      checkVisible(".workspace-rail .mobile-page-header", "workspace header");
      checkVisible(".workspace-rail-list", "workspace list", false, false);
      requireFullWidth(
        rectOf(document.querySelector(".workspace-rail .mobile-page-header")),
        "workspace header",
      );
      checkHorizontal(".workspace-rail-list", "workspace list");
      const workspaceListStyle = getComputedStyle(document.querySelector(".workspace-rail-list"));
      if (!["auto", "scroll"].includes(workspaceListStyle.overflowY)) {
        issues.push("workspace list has no internal vertical scroll owner");
      }
      const entries = [...document.querySelectorAll(".workspace-rail-entry")];
      if (entries.length !== 4) issues.push("expected 4 workspace entries, found " + entries.length);
      entries.forEach((entry, index) => {
        const selector = ".workspace-rail-entry:nth-child(" + (index + 1) + ") .workspace-rail-item";
        checkVisible(selector, "workspace entry " + (index + 1), true, false);
        checkHorizontal(selector, "workspace entry " + (index + 1));
      });
      checkVisible(".workspace-rail-add", "add workspace", true);
      checkVisible(".workspace-rail .mobile-page-header button[aria-label=\\"返回会话列表\\"]", "workspace back", true);
      const add = document.querySelector(".workspace-rail-add");
      if (add?.matches(":disabled")) issues.push("add workspace is disabled");
    }
    if (scene === "chat") {
      checkVisible(".workbench-main .mobile-chat-header", "mobile chat header");
      requireFullWidth(
        rectOf(document.querySelector(".workbench-main .mobile-chat-header")),
        "mobile chat header",
      );
      checkVisible(".workbench-main .transcript", "transcript");
      checkVisible(".workbench-main .composer textarea", "composer textarea", true);
      checkVisible(".workbench-main button.send:not(.stop)", "SEND", true);
      checkVisible(".workbench-main button.send.stop", "STOP", true);
      checkVisible(".workbench-main .mobile-composer-launchers", "mobile launchers");
      checkVisible(".workbench-main .mobile-chat-header button[aria-label=\\"返回会话列表\\"]", "chat back", true);
      checkVisible(".workbench-main .mobile-chat-header button[aria-label=\\"打开设置\\"]", "chat settings", true);
      if (document.querySelector('.workbench-main .mobile-chat-header button[aria-label="打开会话列表"]')) {
        issues.push("mobile chat header retains the redundant AGENTS launcher");
      }
      const launchers = [...document.querySelectorAll(
        ".workbench-main .mobile-composer-launchers button",
      )];
      launchers.forEach((button, index) => checkVisible(
        ".workbench-main .mobile-composer-launchers button:nth-child(" + (index + 1) + ")",
        "launcher " + (index + 1),
        true,
      ));
    }

    const html = document.documentElement;
    const body = document.body;
    const overflow = Math.max(html.scrollWidth, body?.scrollWidth ?? 0) > innerWidth + 1;
    if (overflow) issues.push("document has horizontal overflow");
    return {
      scene,
      issues,
      visibleRoots,
      rects,
      overflow,
      viewport: [innerWidth, innerHeight],
      document: {
        clientWidth: html.clientWidth,
        scrollWidth: html.scrollWidth,
        scrollHeight: html.scrollHeight,
      },
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`Mobile ${scene} scene failed: ${result.issues.join(", ")}`);
  }
  return result;
}

async function inspectMobileSheet(client, kind) {
  const result = await client.evaluate(`(() => {
    const kind = ${JSON.stringify(kind)};
    const definitions = {
      tasks: {
        label: "任务",
        surface: '.loop-list.mobile-sheet-surface:not([hidden])',
        item: ".loop-list-item",
        count: 4,
        close: 'button[aria-label="关闭任务"]',
      },
      pending: {
        label: "等待中",
        surface: '.pending-admissions.mobile-sheet-surface:not([hidden])',
        item: ".pending-admission-item",
        count: 1,
        close: 'button[aria-label="关闭等待中"]',
      },
      controls: {
        label: "控制",
        surface: '.composer-meta.mobile-sheet-surface:not([hidden])',
        item: null,
        count: 0,
        close: 'button[aria-label="关闭控制"]',
      },
    };
    const definition = definitions[kind];
    const issues = [];
    if (!definition) return { kind, issues: ["unknown mobile sheet " + kind] };
    const visible = (element) => {
      if (!element || element.hidden) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden"
        && element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
    };
    const rectOf = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const dialog = document.querySelector(
      '.composer-wrap[role="dialog"][aria-modal="true"]',
    );
    const surface = dialog?.querySelector(definition.surface);
    const surfaces = [...(dialog?.querySelectorAll(".mobile-sheet-surface") ?? [])];
    const backdrop = document.querySelector(".mobile-sheet-backdrop");
    const close = dialog?.querySelector(definition.close);
    const header = surface?.querySelector(".mobile-sheet-header");
    const composer = dialog?.querySelector(".composer");
    const stopButtons = [...(dialog?.querySelectorAll("button.send.stop") ?? [])]
      .filter(visible);
    if (!dialog || !visible(dialog)) issues.push("mobile sheet dialog is not visible");
    if (dialog?.getAttribute("aria-label") !== definition.label) {
      issues.push("mobile sheet dialog aria-label is not " + definition.label);
    }
    if (!surface || !visible(surface)) issues.push(kind + " surface is not visible");
    if (!backdrop || !visible(backdrop)) issues.push(kind + " sheet backdrop is not visible");
    if (!composer || !visible(composer)) issues.push(kind + " dialog composer is not visible");
    if (stopButtons.length !== 1) {
      issues.push("expected one visible STOP in mobile sheet dialog, found " + stopButtons.length);
    }
    const dialogRect = rectOf(dialog);
    const surfaceRect = rectOf(surface);
    const headerRect = rectOf(header);
    const backdropRect = rectOf(backdrop);
    const closeRect = rectOf(close);
    if (dialogRect && (dialogRect.left < -1 || dialogRect.right > innerWidth + 1
      || dialogRect.top < -1 || dialogRect.bottom > innerHeight + 1)) {
      issues.push("mobile sheet dialog crosses the viewport");
    }
    if (surfaceRect && (surfaceRect.left < -1 || surfaceRect.right > innerWidth + 1
      || surfaceRect.top < -1 || surfaceRect.bottom > innerHeight + 1)) {
      issues.push(kind + " surface crosses the viewport");
    }
    if (backdropRect && (backdropRect.left > 1 || backdropRect.top > 1
      || backdropRect.right < innerWidth - 1 || backdropRect.bottom < innerHeight - 1
      || backdropRect.width < innerWidth * 0.9 || backdropRect.height < innerHeight * 0.9)) {
      issues.push(kind + " sheet backdrop is not approximately full viewport");
    }
    if (!header || !visible(header)) issues.push(kind + " surface header is not visible");
    if (!close || !visible(close)) issues.push(kind + " close button is not visible");
    if (closeRect && (closeRect.width < 44 || closeRect.height < 44)) {
      issues.push(kind + " close button is smaller than 44px");
    }
    if (kind === "controls") {
      if (!headerRect || !surfaceRect
        || headerRect.width < surfaceRect.width * 0.9
        || headerRect.left > surfaceRect.left + 1
        || headerRect.right < surfaceRect.left + surfaceRect.width * 0.9) {
        issues.push("controls sheet header is not approximately full surface width");
      }
      if (closeRect && closeRect.left < innerWidth * 0.55) {
        issues.push("controls sheet close button is not on the right side");
      }
    }
    if (!dialog?.contains(document.activeElement)) {
      issues.push(kind + " dialog did not retain focus inside its surface");
    }
    for (const sibling of surfaces) {
      if (sibling !== surface && visible(sibling)) {
        issues.push(kind + " has a visible hidden sibling surface");
      }
    }
    const visibleSurfaceCount = surfaces.filter(visible).length;
    if (visibleSurfaceCount !== 1) {
      issues.push("expected one visible mobile sheet surface, found " + visibleSurfaceCount);
    }
    const surfaceStyle = surface ? getComputedStyle(surface) : null;
    const overflowY = surfaceStyle?.overflowY ?? "";
    if (!["auto", "scroll"].includes(overflowY)) {
      issues.push(kind + " surface has no internal vertical scroll owner");
    }
    const itemElements = definition.item
      ? [...surface.querySelectorAll(definition.item)].filter(visible)
      : [];
    const itemCount = itemElements.length;
    if (itemCount !== definition.count) {
      issues.push("expected " + definition.count + " " + kind + " items, found " + itemCount);
    }
    if (kind === "controls") {
      const required = [
        [".conversation-role-pill", "conversation role"],
        ['select[aria-label="思考级别"]', "thinking level"],
        ['select[aria-label="服务层级"]', "service tier"],
        ['.context-management', "context management"],
        ['button[aria-label="手动压缩上下文"]', "manual compaction"],
      ];
      for (const [selector, label] of required) {
        const element = surface?.querySelector(selector);
        if (!element || !visible(element)) issues.push(label + " is not visible");
      }
      if (surface?.querySelector('button[aria-label="打开设置"], .mobile-model-settings')) {
        issues.push("controls sheet retains a duplicate Settings launcher");
      }
      if ((surface?.querySelectorAll(".compaction-threshold-toggle").length ?? 0) < 2) {
        issues.push("compaction controls are incomplete");
      }
    }
    const html = document.documentElement;
    const body = document.body;
    const overflow = Math.max(html.scrollWidth, body?.scrollWidth ?? 0) > innerWidth + 1;
    if (overflow) issues.push(kind + " sheet introduced horizontal overflow");
    return {
      kind,
      issues,
      dialog: dialogRect,
      sheet: surfaceRect,
      header: headerRect,
      backdrop: backdropRect,
      close: closeRect,
      focusedInside: Boolean(dialog?.contains(document.activeElement)),
      focusedClose: document.activeElement === close,
      overflow,
      overflowY,
      scrollHeight: surface?.scrollHeight ?? null,
      clientHeight: surface?.clientHeight ?? null,
      scrollRange: surface ? Math.max(0, surface.scrollHeight - surface.clientHeight) : null,
      itemCount,
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`Mobile ${kind} sheet failed: ${result.issues.join(", ")}; dialog=${JSON.stringify(result.dialog)}; sheet=${JSON.stringify(result.sheet)}; header=${JSON.stringify(result.header)}; backdrop=${JSON.stringify(result.backdrop)}; close=${JSON.stringify(result.close)}`);
  }
  return result;
}

async function inspectMobileSettings(client, scrolled = false) {
  const result = await client.evaluate(`(() => {
    const expectScrolled = ${scrolled ? "true" : "false"};
    const issues = [];
    const visible = (element) => {
      if (!element || element.hidden) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden"
        && element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
    };
    const rectOf = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height };
    };
    const drawer = document.querySelector('.drawer[role="dialog"][aria-label="设置"]');
    const backdrop = drawer?.parentElement;
    const header = drawer?.querySelector(".drawer-header");
    const close = drawer?.querySelector('button[aria-label="关闭"]');
    const route = drawer?.getAttribute("data-settings-route") ?? "";
    const menuRows = [...(drawer?.querySelectorAll(".settings-menu-row") ?? [])];
    const options = [...(drawer?.querySelectorAll(".color-scheme-option") ?? [])];
    const modelHeading = [...(drawer?.querySelectorAll("h3") ?? [])]
      .find((heading) => heading.textContent?.trim() === "模型目录");
    const drawerRect = rectOf(drawer);
    const headerRect = rectOf(header);
    const closeRect = rectOf(close);
    const modelHeadingRect = rectOf(modelHeading);
    if (!visible(drawer)) issues.push("Settings drawer is not visible");
    if (!drawerRect || Math.abs(drawerRect.left) > 1 || Math.abs(drawerRect.top) > 6
      || Math.abs(drawerRect.right - innerWidth) > 1
      || Math.abs(drawerRect.bottom - innerHeight) > 1) {
      issues.push("Settings is not an edge-to-edge mobile surface");
    }
    const drawerStyle = drawer ? getComputedStyle(drawer) : null;
    const backdropStyle = backdrop ? getComputedStyle(backdrop) : null;
    if (drawerStyle?.position !== "fixed") issues.push("Settings mobile surface is not fixed");
    if (!['auto', 'scroll'].includes(drawerStyle?.overflowY ?? "")) {
      issues.push("Settings has no internal vertical scroll owner");
    }
    if (drawerStyle?.overscrollBehaviorY !== "contain") {
      issues.push("Settings scroll can chain into the page");
    }
    if (backdropStyle?.overflow !== "hidden") issues.push("Settings backdrop does not lock background overflow");
    if (getComputedStyle(header).position !== "sticky") issues.push("Settings header is not sticky");
    if (!closeRect || closeRect.width < 44 || closeRect.height < 44) {
      issues.push("Settings close target is smaller than 44px");
    }
    if (route === "home") {
      if (menuRows.length !== 2) issues.push("Settings HOME does not have exactly two menu rows");
      if (options.length > 0 || drawer?.querySelector('select[aria-label="提供商"], button[aria-label="刷新模型"]')) {
        issues.push("Settings HOME exposes dedicated-page controls");
      }
    } else if (route === "appearance") {
      if (options.length !== 2) issues.push("expected two single-column theme cards");
    } else if (route === "model-connections") {
      if (!drawer?.querySelector('select[aria-label="提供商"]')) issues.push("model provider control is missing");
    } else {
      issues.push("Settings has an unknown route");
    }
    options.forEach((option, index) => {
      const rect = rectOf(option);
      if (!rect || rect.height < 44 || rect.left < -1 || rect.right > innerWidth + 1) {
        issues.push("theme card " + (index + 1) + " is not a full touch target");
      }
      if (index > 0) {
        const previous = rectOf(options[index - 1]);
        if (rect && previous && rect.top < previous.bottom - 1) {
          issues.push("theme cards are not arranged in one column");
        }
      }
    });
    const clippedText = [...(drawer?.querySelectorAll(
      ".drawer-header p:last-child, .settings-section-heading p, .current-model strong, .current-model small, .provider-identity strong, .provider-identity small, .model strong, .model small",
    ) ?? [])].filter((element) => element.scrollWidth > element.clientWidth + 1);
    if (clippedText.length > 0) issues.push("Settings contains horizontally clipped text");
    if (document.querySelector('.composer-meta.mobile-sheet-surface:not([hidden])')) {
      issues.push("Controls sheet remained open behind Settings");
    }
    const html = document.documentElement;
    const body = document.body;
    const overflow = Math.max(html.scrollWidth, body?.scrollWidth ?? 0) > innerWidth + 1;
    if (overflow) issues.push("Settings introduced horizontal overflow");
    if ((document.scrollingElement?.scrollTop ?? 0) !== 0) issues.push("background document scrolled");
    if (expectScrolled) {
      if (route !== "model-connections") issues.push("Settings scrolled check is not on model connections");
      const scrollRange = drawer ? drawer.scrollHeight - drawer.clientHeight : 0;
      if (scrollRange > 1 && (drawer?.scrollTop ?? 0) <= 0) issues.push("Settings did not scroll");
      if (!modelHeadingRect || modelHeadingRect.bottom <= (headerRect?.bottom ?? 0)
        || modelHeadingRect.top >= innerHeight) {
        issues.push("model directory is not reachable after scrolling");
      }
    }
    return {
      issues,
      route,
      drawer: drawerRect,
      header: headerRect,
      close: closeRect,
      modelHeading: modelHeadingRect,
      scrollTop: drawer?.scrollTop ?? null,
      scrollRange: drawer ? drawer.scrollHeight - drawer.clientHeight : null,
      bodyScrollTop: document.scrollingElement?.scrollTop ?? null,
      overflow,
    };
  })()`);
  if (result.issues.length > 0) {
    throw new Error(`Mobile Settings failed: ${result.issues.join(", ")}; ${JSON.stringify(result)}`);
  }
  return result;
}

async function captureMobileScene(client, outputPath, width, height, index, scene, diagnostics) {
  const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
  const name = `${String(index + 1).padStart(2, "0")}-${width}x${height}-fixture-${scene}.png`;
  await writeFile(join(outputPath, name), Buffer.from(screenshot.data, "base64"));
  return {
    name,
    fixture: "workbench",
    mobileScene: scene,
    viewport: [width, height],
    appRoot: "app-shell",
    overflow: diagnostics.overflow,
    mobileDiagnostics: diagnostics,
  };
}

async function exerciseMobileWorkbench(client, outputPath, width, height, index, options = {}) {
  const shouldCapture = options.capture === true;
  const pending = options.pending === true;
  const captures = [];
  const sceneDiagnostics = {};
  const saveScene = async (scene) => {
    const diagnostics = await inspectMobileScene(client, scene);
    sceneDiagnostics[scene] = diagnostics;
    if (shouldCapture) {
      captures.push(await captureMobileScene(
        client,
        outputPath,
        width,
        height,
        index + captures.length,
        scene,
        diagnostics,
      ));
    }
    return diagnostics;
  };
  const saveSheet = async (kind) => {
    const diagnostics = await inspectMobileSheet(client, kind);
    if (shouldCapture) {
      captures.push(await captureMobileScene(
        client,
        outputPath,
        width,
        height,
        index + captures.length,
        kind,
        diagnostics,
      ));
    }
    return diagnostics;
  };

  await saveScene("conversations");
  await clickVisibleButton(client, 'button[aria-label="显示工作区"]');
  await saveScene("workspaces");
  await clickVisibleButton(client, 'button[aria-label="返回会话列表"]');
  await saveScene("conversations");
  await clickVisibleButton(client, 'button[aria-label="打开当前会话"]');
  await saveScene("chat");

  const taskLauncher = 'button[aria-label="打开任务"]';
  await clickVisibleButton(client, taskLauncher);
  const taskOpenFocus = await client.evaluate(`document.activeElement === document.querySelector('button[aria-label="关闭任务"]')`);
  if (!taskOpenFocus) throw new Error("Mobile tasks sheet did not focus its close button");
  await clickVisibleButton(client, '.composer-wrap[role="dialog"][aria-label="任务"] .loop-list-toggle');
  const tasks = await saveSheet("tasks");
  await clickVisibleButton(client, 'button[aria-label="关闭任务"]');
  const afterTasks = await saveScene("chat");
  const taskFocus = await client.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(taskLauncher)})`);
  if (!taskFocus) throw new Error("Mobile tasks sheet did not restore launcher focus");

  const controlsLauncher = 'button[aria-label="打开控制"]';
  await clickVisibleButton(client, controlsLauncher);
  const controls = await saveSheet("controls");
  if (!controls.focusedClose) throw new Error("Mobile controls sheet did not focus its close button");
  await clickVisibleButton(client, 'button[aria-label="关闭控制"]');
  const afterControls = await saveScene("chat");
  const controlsFocus = await client.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(controlsLauncher)})`);
  if (!controlsFocus) throw new Error("Mobile controls sheet did not restore launcher focus");

  // Exercise the hand-off from an existing Controls focus scope. The stable
  // header launcher, rather than the disappearing sheet control, owns return focus.
  await clickVisibleButton(client, controlsLauncher);
  const settingsLauncher = '.mobile-chat-header button[aria-label="打开设置"]';
  const requestedSettings = await client.evaluate(`(() => {
    const launcher = document.querySelector(${JSON.stringify(settingsLauncher)});
    if (!(launcher instanceof HTMLButtonElement)) return false;
    launcher.click();
    return true;
  })()`);
  if (!requestedSettings) throw new Error("Mobile Settings launcher was unavailable");
  await waitForSecondaryInteraction();
  const settings = await inspectMobileSettings(client);
  if (shouldCapture) {
    captures.push(await captureMobileScene(
      client, outputPath, width, height, index + captures.length, "settings-home", settings,
    ));
  }
  await clickVisibleButton(client, '.drawer button[aria-label="打开模型连接设置"]');
  await waitForSecondaryInteraction();
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.max(1, width - 18),
    y: Math.max(1, Math.round(height * 0.7)),
    deltaX: 0,
    deltaY: 10_000,
  });
  await waitForSecondaryInteraction();
  const settingsScrolled = await inspectMobileSettings(client, true);
  if (shouldCapture) {
    captures.push(await captureMobileScene(
      client, outputPath, width, height, index + captures.length,
      "settings-connections", settingsScrolled,
    ));
  }
  await client.call("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await waitForSecondaryInteraction();
  const settingsHomeFocus = await client.evaluate(`document.activeElement === document.querySelector('.drawer button[aria-label="打开模型连接设置"]')`);
  if (!settingsHomeFocus) throw new Error("Mobile Settings Escape did not return to HOME row");
  await client.call("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await waitForSecondaryInteraction();
  const settingsFocus = await client.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(settingsLauncher)})`);
  if (!settingsFocus) throw new Error("Mobile Settings did not restore its stable header launcher");
  await clickVisibleButton(client, settingsLauncher);
  await clickVisibleButton(client, '.drawer button[aria-label="关闭"]');
  const settingsCloseFocus = await client.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(settingsLauncher)})`);
  if (!settingsCloseFocus) throw new Error("Mobile Settings close did not restore its header launcher");

  let pendingDiagnostics = null;
  if (pending) {
    const pendingLauncher = 'button[aria-label="打开等待中"]';
    await clickVisibleButton(client, pendingLauncher);
    pendingDiagnostics = await saveSheet("pending");
    if (!pendingDiagnostics.focusedClose) throw new Error("Mobile pending sheet did not focus its close button");
  }
  if (!shouldCapture) {
    return {
      sceneDiagnostics,
      tasks,
      afterTasks,
      controls,
      afterControls,
      settings,
      settingsScrolled,
      pending: pendingDiagnostics,
    };
  }
  return captures;
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
    const usesWorkbench = [
      "context-tooltip",
      "activity-expanded",
      "commitment-expanded",
      "jump-latest",
      "jump-latest-focus",
      "composer-states",
    ].includes(surface.surface);
    let interaction = null;
    if (usesWorkbench && width <= 600) {
      interaction = await exerciseMobileWorkbench(
        client,
        null,
        width,
        height,
        index,
        { pending: surface.surface === "composer-states" },
      );
    } else if (usesWorkbench) {
      const compactRebelFixture = [
        "activity-expanded",
        "commitment-expanded",
        "composer-states",
      ].includes(surface.surface) && width <= 960;
      const collapsedMobileSidebar = await client.evaluate(`(() => {
        if (innerWidth > 600 && !${JSON.stringify(compactRebelFixture)}) return false;
        const toggle = document.querySelector(".conversation-sidebar-toggle");
        if (toggle?.getAttribute("aria-expanded") !== "true") return false;
        toggle.click();
        return true;
      })()`);
      if (collapsedMobileSidebar) await waitForSecondaryInteraction();
    }
    if (surface.surface === "context-tooltip") {
      if (width <= 600) {
        await clickVisibleButton(client, 'button[aria-label="打开控制"]');
        await inspectMobileSheet(client, "controls");
      }
      await revealContextTooltip(client);
    }
    if (surface.surface === "activity-expanded") interaction = await expandActivityLedger(client);
    if (surface.surface === "commitment-expanded") {
      interaction = await expandCommitmentCard(
        client,
        width <= 600 ? outputPath : null,
        width <= 600 ? `commitment-expanded-product-bug-${width}x${height}.png` : null,
      );
    }
    if (surface.surface === "jump-latest") interaction = await exerciseJumpLatest(client, false);
    if (surface.surface === "jump-latest-focus") interaction = await exerciseJumpLatest(client, true);
    if (surface.surface === "composer-states" && width > 600) {
      interaction = await exerciseComposerStates(
        client,
        outputPath,
        `composer-states-product-bug-${width}x${height}.png`,
      );
    }
    diagnostics = await inspectSecondarySurface(client, surface);
    diagnostics.interaction = interaction;
  } else if (visualFixture) {
    if (width <= 600) {
      return exerciseMobileWorkbench(client, outputPath, width, height, index, { capture: true });
    }
    const ready = await client.evaluate(`(() => {
      const fixture = document.querySelector('[data-visual-fixture="populated-workbench"]');
      const tasks = fixture?.querySelector('.loop-list-toggle');
      if (!fixture || !tasks) return false;
      if (
        tasks.getClientRects().length > 0
        && tasks.getAttribute('aria-expanded') !== 'true'
      ) tasks.click();
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
      ...(diagnostics.interaction ? { interaction: diagnostics.interaction } : {}),
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
  if (
    surfaceMode
    && requestedSurfaceName === undefined
    && !["A", "B", "ALL"].includes(normalizedSurfaceOption)
  ) {
    throw new Error("--surfaces must be A, B, all, or a named surface");
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
        .filter(([surfaceName, definition]) => requestedSurfaceName !== undefined
          ? surfaceName === requestedSurfaceName
          : normalizedSurfaceOption === "ALL"
            || definition.group === normalizedSurfaceOption)
        .map(([surfaceName]) => surfaceName);
      let index = 0;
      for (const surfaceName of surfaceNames) {
        const surface = {
          surface: surfaceName,
          ...secondarySurfaceDefinitions[surfaceName],
        };
        const surfaceViewports = requestedViewport || motionEvidence
          ? viewports
          : surface.viewports ?? viewports;
        for (const viewport of surfaceViewports) {
          const capture = await captureViewport(
            client,
            runDir,
            viewport[0],
            viewport[1],
            index,
            surface,
          );
          if (Array.isArray(capture)) captures.push(...capture);
          else captures.push(capture);
          index += 1;
        }
      }
    } else {
      for (const [index, viewport] of viewports.entries()) {
        const capture = await captureViewport(client, runDir, viewport[0], viewport[1], index);
        if (Array.isArray(capture)) captures.push(...capture);
        else captures.push(capture);
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
