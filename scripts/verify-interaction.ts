#!/usr/bin/env node
// Run after `npm run build`: npx --no-install tsx scripts/verify-interaction.ts
// Real browser/HTTP/WS/SDK/JSONL; only model responses are local deterministic fixtures.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  BUSY_PROMPT, FIRST_PROMPT, LOCAL_IMAGE_DATA, LOCAL_IMAGE_NAME, STEER_PROMPT, TITLE, startInteractionFixture,
} from "./interaction-fixture.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(root, ".visual-validation", `interaction-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type Frame = { direction: "sent" | "received"; at: number; payload: Record<string, any> };

async function waitFor<T>(label: string, check: () => T | Promise<T>, timeout = 12_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value as NonNullable<T>;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout;
  }>();
  readonly frames: Frame[] = [];
  readonly browserErrors: unknown[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method === "Network.webSocketFrameReceived" || message.method === "Network.webSocketFrameSent") {
        const rawFrame = message.params.response.payloadData;
        this.frames.push({
          direction: message.method.endsWith("Sent") ? "sent" : "received",
          at: Date.now(), payload: JSON.parse(rawFrame),
        });
      } else if (message.method === "Runtime.exceptionThrown") {
        this.browserErrors.push(message.params.exceptionDetails);
      }
    });
    this.socket.on("error", (error) => this.browserErrors.push(String(error)));
  }

  async open(): Promise<void> {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 5_000);
      this.socket.once("open", () => { clearTimeout(timer); done(); });
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }

  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, 5_000);
      this.pending.set(id, { resolve: done, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<any> {
    const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP client closed"));
    }
    this.pending.clear();
    this.socket.terminate();
  }
}

function findBrowser(): string {
  const candidates = [
    process.env.PIWEB_BROWSER,
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft/Edge/Application/msedge.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  const browser = candidates.find((path) => path && existsSync(path));
  if (!browser) throw new Error("Set PIWEB_BROWSER to a Chromium-compatible browser executable");
  return browser;
}

async function browserPort(): Promise<number> {
  const server = createServer();
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      server.close((error) => error ? reject(error) : done(address.port));
    });
  });
}

async function stopBrowser(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      const timer = setTimeout(() => { killer.kill(); done(); }, 5_000);
      killer.once("close", () => { clearTimeout(timer); done(); });
      killer.once("error", () => { clearTimeout(timer); done(); });
    });
  } else {
    child.kill("SIGTERM");
    await waitFor("owned browser exit", () => child.exitCode !== null, 3_000)
      .catch(() => { child.kill("SIGKILL"); });
  }
}

function entryText(entry: any): string {
  const content = entry?.message?.content;
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
    : "";
}

async function diskConversation(cwd: string, conversationId: string): Promise<{ raw: string; entries: any[] }> {
  const directory = join(cwd, ".piweb", "sessions");
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    const raw = await readFile(join(directory, name), "utf8");
    const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
    if (entries[0]?.id !== conversationId) continue;
    assert(raw.endsWith("\n"), "JSONL must end with a complete append");
    return { raw, entries };
  }
  throw new Error(`No durable conversation header for ${conversationId}`);
}

async function main(): Promise<void> {
  assert(existsSync(join(root, "dist-client/index.html")), "Run npm run build first");
  await mkdir(artifactDir, { recursive: true });
  const fixture = await startInteractionFixture(join(root, "dist-client"));
  let profile: string | undefined;
  let child: ChildProcess | undefined;
  let client: CdpClient | undefined;
  let passed = false;
  const evidence: Record<string, unknown> = { generatedAt: new Date().toISOString(), url: fixture.url };
  try {
    profile = await mkdtemp(join(artifactDir, ".browser-profile-"));
    const health = await fetch(`${fixture.url}/health`, { signal: AbortSignal.timeout(5_000) });
    assert.deepEqual(await health.json(), { ok: true });
    const port = await browserPort();
    const browser = findBrowser();
    evidence.browser = browser;
    child = spawn(browser, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
      "--disable-background-networking", "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: "ignore" });
    child.on("error", (error) => { evidence.browserSpawnError = String(error); });
    const targets = await waitFor("Chrome DevTools endpoint", async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
        return response.ok ? await response.json() as any[] : undefined;
      } catch { return undefined; }
    });
    const target = targets.find((item) => item.type === "page");
    assert(target?.webSocketDebuggerUrl);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.open();
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await client.call("Network.enable");
    await client.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await client.call("Page.navigate", { url: fixture.url });
    const ui = client;
    const received = (predicate: (payload: any) => boolean) => ui.frames.find((frame) => frame.direction === "received" && predicate(frame.payload))?.payload;
    const sent = (text: string, startIndex: number) => ui.frames.slice(startIndex).find((frame) => frame.direction === "sent" && frame.payload.type === "prompt" && frame.payload.text === text)?.payload;
    const click = async (selector: string) => {
      await waitFor(`enabled UI ${selector}`, () => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`));
      await ui.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    };
    const input = async (selector: string, value: string) => {
      await ui.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await ui.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
      await ui.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
      await ui.call("Input.insertText", { text: value });
    };
    const send = async (text: string) => {
      const startIndex = ui.frames.length;
      await waitFor("editable composer", () => ui.evaluate('Boolean(document.querySelector("textarea") && !document.querySelector("textarea").disabled)'));
      await input('textarea[aria-label="给 Pi 发送消息"]', text);
      await click('button[aria-label="发送"]');
      return waitFor(`browser transport ${text}`, () => sent(text, startIndex));
    };

    await waitFor("workbench hello", () => received((event) => event.type === "hello"));
    if (!await ui.evaluate('Boolean(document.querySelector("#cwd"))')) await click('button[aria-label="添加工作区"]');
    await input("#cwd", fixture.cwd);
    await click(".setup-card button:not([type])");
    await waitFor("available role selection", () => ui.evaluate('Boolean(document.querySelector(".role-card-start:not(:disabled)"))'));
    await click(".role-card-start:not(:disabled)");
    const initialSnapshot = await waitFor("authoritative initial history", () => received((event) => event.type === "conversation_snapshot"));
    const conversationId = initialSnapshot.conversationId;
    console.log("E2E: browser initialized with authoritative history");

    const imageBytes = Buffer.alloc(8 * 1024 * 1024);
    // Valid 1x1 PNG plus inert trailing bytes exercises original-file size without lossy resizing.
    const pngData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    Buffer.from(pngData, "base64").copy(imageBytes);
    const pasteImages = async (sizes: number[]) => {
      await ui.evaluate(`(() => {
        const png = Uint8Array.from(atob(${JSON.stringify(pngData)}), (character) => character.charCodeAt(0));
        const clipboardData = new DataTransfer();
        ${JSON.stringify(sizes)}.forEach((size, index) => {
          const bytes = new Uint8Array(size);
          bytes.set(png);
          clipboardData.items.add(new File([bytes], index + ".png", { type: "image/png" }));
        });
        document.querySelector('textarea[aria-label="给 Pi 发送消息"]').dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }),
        );
      })()`);
    };
    await waitFor("editable image composer", () => ui.evaluate('Boolean(document.querySelector("textarea") && !document.querySelector("textarea").disabled)'));
    await pasteImages([imageBytes.length + 1]);
    await waitFor("8 MiB + 1 rejected without a prompt", () => ui.evaluate('document.body.innerText.includes("单张图片最多 8 MiB。")'));
    assert.equal(ui.frames.filter((frame) => frame.direction === "sent" && frame.payload.type === "prompt").length, 0);
    await pasteImages([imageBytes.length, imageBytes.length]);
    await waitFor("two original images decoded and previewed", () => ui.evaluate('document.querySelectorAll(".composer-attachment img").length === 2 && [...document.querySelectorAll(".composer-attachment img")].every((image) => image.complete && image.naturalWidth === 1)'));
    const firstCommand = await send(FIRST_PROMPT);
    const originalData = imageBytes.toString("base64");
    assert.deepEqual(firstCommand.images.map((image: any) => image.data), [originalData, originalData]);
    const imageFrameBytes = Buffer.byteLength(JSON.stringify(firstCommand));
    assert(imageFrameBytes > 1_000_000 && imageFrameBytes < 24 * 1024 * 1024);
    assert.equal(firstCommand.conversationId, conversationId);
    await waitFor("host run_queued", () => received((event) => event.type === "session_event" && event.runId === firstCommand.runId && event.event.type === "run_queued"));
    await waitFor("first model call while title gate is closed", () => fixture.log.some((event) => event.kind === "model_requested" && event.text?.includes(FIRST_PROMPT)));
    await waitFor("first run settles while title gate is closed", () => received((event) => event.type === "conversation_run_settled" && event.runId === firstCommand.runId && event.outcome === "completed"));
    assert(fixture.log.some((event) => event.kind === "title_requested"));
    assert(!fixture.log.some((event) => event.kind === "title_returned"), "title gate was not released");
    const firstDisk = await diskConversation(fixture.cwd, conversationId);
    const titleRequest = fixture.log.find((event) => event.kind === "title_requested");
    const firstModelRequest = fixture.log.find((event) => event.kind === "model_requested");
    assert(titleRequest && firstModelRequest);
    assert.equal(titleRequest.sessionId, firstDisk.entries[0].id, "title belongs to the durable Pi session");
    assert.equal(firstModelRequest.sessionId, titleRequest.sessionId);
    assert.equal(typeof titleRequest.transport, "string");
    assert.equal(titleRequest.transport, firstModelRequest.transport, "title inherits session transport");
    evidence.titleSessionAttribution = { sessionId: titleRequest.sessionId, transport: titleRequest.transport };
    assert(firstDisk.entries.some((entry) => entry.customType === "piweb.run_settlement.v1" && entry.data.runId === firstCommand.runId && entry.data.outcome === "completed"));
    const firstUsers = firstDisk.entries.filter((entry) => entry.message?.role === "user" && entryText(entry) === FIRST_PROMPT);
    assert.equal(firstUsers.length, 1);
    const firstUser = firstUsers[0];
    assert.deepEqual(firstUser.message.content.filter((part: any) => part.type === "image").map((image: any) => image.data), [originalData, originalData], "real SDK persists both original images unchanged");
    assert(firstDisk.entries.some((entry) => entry.message?.role === "assistant" && entryText(entry).includes("FIRST RESPONSE")));
    await waitFor("first response rendered", () => ui.evaluate('document.body.innerText.includes("FIRST RESPONSE")'));
    evidence.titleDidNotGateFirstRun = true;
    console.log("E2E: first model call, settlement and JSONL precede title release");

    assert(!received((event) => event.type === "local_image"), "local files must not load before a click");
    const imagePoint = await waitFor("local image link rendered", () => ui.evaluate(`(() => {
      const link = document.querySelector('button[data-piweb-local-image]');
      if (!link) return undefined;
      link.scrollIntoView({ block: 'center' });
      const rect = link.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`));
    await ui.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...imagePoint });
    await ui.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...imagePoint });
    const localResponse = await waitFor("local file preview response", () => received((event) => event.type === "local_image"));
    const localCommand = ui.frames.find((frame) => frame.direction === "sent" && frame.payload.type === "open_local_image")?.payload;
    assert(localCommand);
    assert.equal(localResponse.commandId, localCommand.commandId);
    assert.equal(localResponse.sessionId, initialSnapshot.sessionId);
    assert.equal(localResponse.conversationId, conversationId);
    assert.equal(localResponse.focusId, initialSnapshot.focusId);
    assert.equal(localResponse.path, `./${LOCAL_IMAGE_NAME}`);
    assert.equal(localResponse.data, LOCAL_IMAGE_DATA);
    const popup = await waitFor("native image popup", async () => {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
      return pages.find((page) => page.type === "page" && page.url.startsWith("blob:"));
    });
    const imageViewer = new CdpClient(popup.webSocketDebuggerUrl);
    try {
      await imageViewer.open();
      await waitFor("browser decoded the local image", () => imageViewer.evaluate(
        'Boolean(document.querySelector("img")?.complete && document.querySelector("img")?.naturalWidth === 1)',
      ));
      const screenshot = await imageViewer.call("Page.captureScreenshot", { format: "png" });
      await writeFile(join(artifactDir, "local-image.png"), Buffer.from(screenshot.data, "base64"));
    } finally {
      imageViewer.close();
    }
    assert.equal((await diskConversation(fixture.cwd, conversationId)).raw, firstDisk.raw, "local preview must not mutate history");
    evidence.localImagePreview = { clickOnly: true, exactBytes: true, nativePopupDecoded: true, historyUnchanged: true };
    console.log("E2E: clicked local Unicode/space path opened in a native image tab without history writes");

    const busyCommand = await send(BUSY_PROMPT);
    await waitFor("held streaming model call", () => fixture.log.some((event) => event.kind === "model_requested" && event.text?.includes(BUSY_PROMPT)));
    await pasteImages([imageBytes.length]);
    await waitFor("original image ready for busy steering", () => ui.evaluate('Boolean(document.querySelector(".composer-attachment img")?.naturalWidth === 1)'));
    const steerCommand = await send(STEER_PROMPT);
    assert.deepEqual(steerCommand.images.map((image: any) => image.data), [originalData]);
    const admission = await waitFor("host steering admission", () => received((event) => event.type === "prompt_admitted" && event.promptId === steerCommand.promptId));
    assert.equal(admission.conversationId, conversationId);
    assert(!received((event) => event.type === "prompt_delivered" && event.promptId === steerCommand.promptId));
    const beforeDelivery = await diskConversation(fixture.cwd, conversationId);
    assert(!beforeDelivery.entries.some((entry) => entry.message?.role === "user" && entryText(entry) === STEER_PROMPT));
    await waitFor("pending UI feedback", () => ui.evaluate('document.body.innerText.includes("等待中") || document.body.innerText.includes("等待处理")'));
    evidence.admittedWasNotDelivered = true;

    // Same text is not identity: withdraw the later slot, preserving the first
    // slot (and any original images) through reconnect and durable delivery.
    const duplicateCommand = await send(STEER_PROMPT);
    assert.notEqual(duplicateCommand.promptId, steerCommand.promptId);
    await waitFor("duplicate admission", () => received((event) => event.type === "prompt_admitted" && event.promptId === duplicateCommand.promptId));
    await waitFor("two pending rows", () => ui.evaluate('document.querySelectorAll(".pending-admission-item").length === 2'));
    await click(".pending-admission-item:last-child .pending-admission-withdraw");
    const withdrawal = await waitFor("exact withdrawal command", () => ui.frames.find((frame) => frame.direction === "sent"
      && frame.payload.type === "withdraw_prompt" && frame.payload.promptId === duplicateCommand.promptId)?.payload);
    assert.equal(withdrawal.runId, busyCommand.runId);
    await waitFor("authoritative withdrawal broadcast", () => received((event) => event.type === "prompt_withdrawn" && event.promptId === duplicateCommand.promptId && event.runId === busyCommand.runId));
    await waitFor("source withdrawal receipt", () => received((event) => event.type === "command_complete" && event.operation === "withdraw_prompt" && event.commandId === withdrawal.commandId));
    await waitFor("one retained pending row", () => ui.evaluate('document.querySelectorAll(".pending-admission-item").length === 1'));
    assert(!received((event) => event.type === "prompt_delivered" && event.promptId === duplicateCommand.promptId));
    evidence.withdrawal = { retainedPromptId: steerCommand.promptId, withdrawnPromptId: duplicateCommand.promptId, runId: withdrawal.runId, commandId: withdrawal.commandId };
    console.log("E2E: exact same-text duplicate withdrawn while original slot remains queued");

    await fixture.disconnectBrowsers();
    const recovered = await waitFor("new exact reconnect snapshot with pending admission", () => received((event) => event.type === "conversation_snapshot"
      && event.conversationId === conversationId && event.sessionId !== admission.sessionId
      && event.pendingPrompts.some((pending: any) => pending.promptId === steerCommand.promptId)));
    assert.notEqual(recovered.focusId, admission.focusId);
    assert.deepEqual(recovered.pendingPrompts.map((pending: any) => pending.promptId), [steerCommand.promptId]);
    await waitFor("reconnected history rendered", () => ui.evaluate('document.body.innerText.includes("FIRST RESPONSE")'));
    evidence.reconnect = {
      conversationId, oldSessionId: admission.sessionId, newSessionId: recovered.sessionId,
      oldFocusId: admission.focusId, newFocusId: recovered.focusId, pendingPromptId: steerCommand.promptId,
    };
    console.log("E2E: busy admission recovered in a new exact snapshot, not yet delivered");
    const restoredImage = recovered.items.find((item: any) => item.kind === "message" && item.id === firstUser.id);
    assert.deepEqual(restoredImage.imageRefs.map((ref: any) => ref.source), [
      { messageId: firstUser.id, imageOrdinal: 0 }, { messageId: firstUser.id, imageOrdinal: 1 },
    ]);
    assert(!JSON.stringify(recovered).includes(originalData), "history contains markers, never image bytes");
    await ui.call("Runtime.evaluate", {
      expression: 'document.querySelector(\'button[aria-label="在新标签页中打开图片 1"]\').click()',
      userGesture: true,
    });
    const imageResponse = await waitFor("exact durable image response after reconnect", () => received((event) => (
      event.type === "conversation_image" && event.sessionId === recovered.sessionId
      && event.focusId === recovered.focusId && event.messageId === firstUser.id && event.imageOrdinal === 0
    )));
    assert.equal(imageResponse.data, originalData);
    evidence.imageUpload = {
      count: 2, bytesEach: imageBytes.length, aggregateBytes: imageBytes.length * 2,
      frameBytes: imageFrameBytes, oversizedRejected: true, originalSdkBytesPersisted: true,
      markerOnlyHistoryRestored: true, exactImageReadAfterReconnect: true,
    };
    console.log("E2E: two original 8 MiB images persisted, restored as markers and opened byte-exactly");

    fixture.releaseBusyTurn();
    const delivered = await waitFor("raw durable user delivery", () => received((event) => event.type === "prompt_delivered" && event.promptId === steerCommand.promptId));
    assert.equal(delivered.sessionId, recovered.sessionId);
    assert.equal(delivered.focusId, recovered.focusId);
    assert.equal(delivered.runId, busyCommand.runId);
    await waitFor("busy run and follow-up settle", () => received((event) => event.type === "conversation_run_settled" && event.runId === busyCommand.runId && event.outcome === "completed"));
    await waitFor("follow-up response rendered", () => ui.evaluate('document.body.innerText.includes("FOLLOW-UP RESPONSE")'));
    fixture.releaseTitle();
    await waitFor("late automatic title rendered", () => ui.evaluate(`document.body.innerText.includes(${JSON.stringify(TITLE)})`));
    const finalDisk = await diskConversation(fixture.cwd, conversationId);
    for (const prompt of [FIRST_PROMPT, BUSY_PROMPT, STEER_PROMPT]) {
      assert.equal(finalDisk.entries.filter((entry) => entry.message?.role === "user" && entryText(entry) === prompt).length, 1, `one durable user entry for ${prompt}`);
    }
    const steeringUser = finalDisk.entries.find((entry) => entry.message?.role === "user" && entryText(entry) === STEER_PROMPT);
    assert.deepEqual(steeringUser.message.content.filter((part: any) => part.type === "image").map((image: any) => image.data), [originalData], "busy steering persists the accepted image unchanged exactly once");
    evidence.steeringImageBytesPersisted = imageBytes.length;
    assert(finalDisk.entries.some((entry) => entry.message?.role === "assistant" && entryText(entry).includes("FOLLOW-UP RESPONSE")));
    assert(finalDisk.entries.some((entry) => entry.type === "session_info" && entry.name === TITLE));
    assert.equal(fixture.log.filter((event) => event.kind === "title_requested").length, 1);
    assert.equal(fixture.log.filter((event) => event.kind === "model_requested").length, 3);
    assert.equal(finalDisk.entries.filter((entry) => entry.message?.role === "assistant").length, 3, "title must not append an Agent turn");
    const settlements = finalDisk.entries.filter((entry) => entry.customType === "piweb.run_settlement.v1");
    assert.equal(settlements.length, 2, "title must not start another host run");
    assert.deepEqual(new Set(settlements.map((entry) => entry.data.runId)), new Set([firstCommand.runId, busyCommand.runId]));
    evidence.titleDidNotStartAgentTurn = true;
    assert.equal(ui.frames.filter((frame) => frame.direction === "sent" && frame.payload.type === "prompt").length, 4, "reconnect must not resend prompts");
    assert(!received((event) => event.type === "prompt_delivered" && event.promptId === duplicateCommand.promptId), "withdrawn duplicate must never deliver");
    assert.deepEqual(ui.browserErrors, []);
    evidence.transitionMeasures = await ui.evaluate('performance.getEntriesByName("piweb.transition", "measure").map((entry) => ({ duration: entry.duration, detail: entry.detail }))');
    await writeFile(join(artifactDir, "conversation.jsonl"), finalDisk.raw);
    const screenshot = await ui.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(artifactDir, "browser.png"), Buffer.from(screenshot.data, "base64"));
    passed = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.stack : String(error);
    if (client) evidence.failureBody = await client.evaluate("document.body.innerText").catch(() => undefined);
    throw error;
  } finally {
    try {
      client?.close();
      try {
        if (child) await stopBrowser(child);
      } finally {
        try {
          await fixture.close();
        } finally {
          if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
      }
      evidence.cleanedUp = true;
    } catch (error) {
      passed = false;
      evidence.cleanupError = error instanceof Error ? error.stack : String(error);
      throw error;
    } finally {
      await writeFile(join(artifactDir, "evidence.json"), JSON.stringify({ ...evidence, passed, fixtureLog: fixture.log, frames: client?.frames, browserErrors: client?.browserErrors }, null, 2));
    }
  }
  console.log(`E2E PASS: real SDK follow-up persisted once; owners cleaned up; evidence ${artifactDir}`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
