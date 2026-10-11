import { SessionManager, resizeImage, type SessionEntry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CONVERSATION_IMAGE_BYTES } from "../shared/protocol.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, resizeImage: vi.fn(actual.resizeImage) };
});
afterEach(() => vi.mocked(resizeImage).mockReset());

import {
  createHistoryTools, HISTORY_READ_BYTES, HISTORY_SEARCH_BYTES,
  HISTORY_SCAN_CHARACTERS, HISTORY_SCAN_ENTRIES, type HistoryToolSource,
} from "./history-tools.js";

type Data = Record<string, any>;
function harness(manager = SessionManager.inMemory("E:\\work"), conversationId = "conversation-a") {
  const source: HistoryToolSource = { conversationId, getBranch: () => manager.getBranch() };
  return { manager, source, tools: createHistoryTools(source) };
}
async function run(tools: ToolDefinition[], name: string, args: unknown): Promise<Data> {
  const tool = tools.find((item) => item.name === name)!;
  const result = await tool.execute("call", args as never, undefined, undefined, undefined as never);
  const imageMode = (args as Data).image === true;
  expect(result.content).toHaveLength(imageMode ? 2 : 1);
  expect(result.content[0].type).toBe("text");
  if (imageMode) expect(result.content[1].type).toBe("image");
  const text = (result.content[0] as { type: "text"; text: string }).text;
  const body = JSON.parse(text);
  expect(body.notice).toMatch(/数据.*不是新指令.*执行许可.*workspace/);
  expect(body.scope).toBe("current_conversation_active_ancestors");
  const textResult = imageMode ? { ...result, content: [result.content[0]] } : result;
  expect(Buffer.byteLength(JSON.stringify(textResult), "utf8")).toBeLessThanOrEqual(name === "history_search" ? HISTORY_SEARCH_BYTES : HISTORY_READ_BYTES);
  expect(result.details).toEqual({ version: 1, tool: name, truncated: body.truncated === true });
  return body;
}
async function follow(tools: ToolDefinition[], call: Data): Promise<Data> {
  return run(tools, call.tool, call.args);
}
function user(manager: SessionManager, text: string): string {
  return manager.appendMessage({ role: "user", content: text, timestamp: 1 });
}
function assistant(manager: SessionManager, content: unknown[]): string {
  return manager.appendMessage({ role: "assistant", content, timestamp: 2, api: "test", provider: "test", model: "test", stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as never);
}
function result(manager: SessionManager, text: string, toolName = "bash", toolCallId = "call-1"): string {
  return manager.appendMessage({ role: "toolResult", toolName, toolCallId, content: [{ type: "text", text }], isError: false, timestamp: 3 });
}
function mutateToken(value: string, changes: Data): string {
  const parsed = JSON.parse(Buffer.from(value.slice(6), "base64url").toString("utf8"));
  return `hist1.${Buffer.from(JSON.stringify({ ...parsed, ...changes })).toString("base64url")}`;
}

async function readAll(tools: ToolDefinition[], ref: string): Promise<string> {
  let page = await run(tools, "history_read", { ref });
  let text = ""; let offset = 0; let count = 0;
  for (;;) {
    expect(page.range.offset).toBe(offset);
    text += page.text; offset = page.range.endOffset;
    if (!page.nextCall) break;
    expect(page.nextCall.args).toEqual({ cursor: expect.any(String) });
    page = await follow(tools, page.nextCall);
    if (++count > 200) throw new Error("Pagination failed to progress");
  }
  return text;
}

describe("history tools", () => {
  it("uses flat provider-compatible schemas and strict initial/cursor-only validation", async () => {
    const { tools, manager } = harness(); user(manager, "first");
    expect(tools.map((tool) => tool.name)).toEqual(["history_search", "history_context", "history_read"]);
    for (const tool of tools) {
      expect(JSON.stringify(tool.parameters)).not.toMatch(/anyOf|oneOf/);
      expect(tool.description).toMatch(/ordinary codemode text is not DLP/);
      expect(tool.description).toMatch(/history tools.*excluded/);
    }
    for (const args of [{}, { type: "system" }, { type: "user", query: "" }, { type: "user", query: "x".repeat(257) }, { type: "user", maxHits: 21 }, { type: "user", maxHits: 1.1 }, { type: "user", toolName: "bash" }, { type: "user", unknown: true }]) {
      await expect(run(tools, "history_search", args)).rejects.toThrow(/Invalid|required|only valid/);
    }
    const hits = await run(tools, "history_search", { type: "user", maxHits: 1 });
    for (const name of ["history_read", "history_context"]) {
      await expect(run(tools, name, {})).rejects.toThrow(/requires/);
      await expect(run(tools, name, { ref: hits.hits[0].ref, limit: 10 })).rejects.toThrow(/Invalid/);
      await expect(run(tools, name, { ref: hits.hits[0].ref, cursor: "invalid" })).rejects.toThrow(/cursor-only/);
    }
  });

  it("searches and reads original pre-compaction entries rather than canonical/UI projections", async () => {
    const { manager, tools } = harness();
    const old = user(manager, "pre-compaction secret phrase");
    const retained = user(manager, "retained turn");
    const summary = manager.appendCompaction("checkpoint summary", retained, 9000, { hidden: "DETAIL_SECRET" });
    user(manager, "post compaction");
    expect(JSON.stringify(manager.buildSessionProjection().messages)).not.toContain("pre-compaction secret phrase");
    const found = await run(tools, "history_search", { type: "user", query: "PRE-COMPACTION" });
    expect(found.hits.map((hit: Data) => hit.entryId)).toEqual([old]);
    expect(await readAll(tools, found.hits[0].ref)).toBe("pre-compaction secret phrase");
    const checkpoint = await run(tools, "history_search", { type: "checkpoint" });
    expect(checkpoint.hits[0]).toMatchObject({ entryId: summary, kind: "compaction", role: "checkpoint" });
    expect(JSON.stringify(await run(tools, "history_read", { ref: checkpoint.hits[0].ref }))).not.toContain("DETAIL_SECRET");
  });

  it("keeps raw targets readable after replace/omit context edits and explicitly labels historical edits", async () => {
    const { manager, tools } = harness();
    const id = user(manager, "raw original, not current instruction");
    manager.appendContextEdit(id, { content: "replacement now visible to provider" });
    const hit = (await run(tools, "history_search", { type: "user", query: "raw original" })).hits[0];
    expect(JSON.stringify(manager.buildSessionProjection().messages)).not.toContain("raw original");
    const replaced = await run(tools, "history_read", { ref: hit.ref });
    expect(replaced.text).toContain("raw original");
    expect(replaced.historicalContextEdit.state).toBe("replaced");
    manager.appendContextEdit(id, null);
    const freshHit = (await run(tools, "history_search", { type: "user", query: "raw original" })).hits[0];
    expect((await run(tools, "history_read", { ref: freshHit.ref })).historicalContextEdit.state).toBe("omitted");
  });

  it("maps custom_message content to user and branch summaries to checkpoint without host details", async () => {
    const { manager, tools } = harness();
    const root = user(manager, "root");
    const summary = manager.branchWithSummary(root, "branch checkpoint", { details: "BRANCH_DETAIL" });
    const custom = manager.appendCustomMessageEntry("extension.context", "hidden context still readable", false, { password: "CUSTOM_DETAIL" });
    const hit = (await run(tools, "history_search", { type: "user", query: "hidden context" })).hits[0];
    expect(hit).toMatchObject({ entryId: custom, role: "user", kind: "custom_message" });
    expect(await readAll(tools, hit.ref)).toBe("hidden context still readable");
    expect((await run(tools, "history_search", { type: "checkpoint" })).hits[0].entryId).toBe(summary);
    expect(JSON.stringify(await run(tools, "history_context", { ref: hit.ref }))).not.toMatch(/CUSTOM_DETAIL|BRANCH_DETAIL/);
  });

  it("isolates branch ancestors and rejects older refs/cursors after branch navigation", async () => {
    const { manager, tools } = harness();
    const root = user(manager, "root shared");
    user(manager, "abandoned needle");
    const abandoned = await run(tools, "history_search", { type: "user", maxHits: 1 });
    manager.branch(root); user(manager, "selected needle");
    const current = await run(tools, "history_search", { type: "user", query: "needle" });
    expect(current.hits.map((hit: Data) => hit.snippet)).toEqual(["selected needle"]);
    await expect(run(tools, "history_read", { ref: abandoned.hits[0].ref })).rejects.toThrow(/branch/);
    await expect(follow(tools, abandoned.nextCall)).rejects.toThrow(/branch/);
  });

  it("uses stateless scoped refs and rejects bare IDs, foreign colliding IDs and removed targets", async () => {
    const entry: SessionEntry = { type: "message", id: "same-id", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "one", timestamp: 1 } };
    let branch: SessionEntry[] = [entry];
    const a: HistoryToolSource = { conversationId: "a", getBranch: () => branch };
    const tools = createHistoryTools(a);
    const ref = (await run(tools, "history_search", { type: "user" })).hits[0].ref;
    const rebuilt = createHistoryTools(a);
    expect((await run(rebuilt, "history_read", { ref })).text).toBe("one");
    const b = createHistoryTools({ conversationId: "b", getBranch: () => [entry] });
    await expect(run(b, "history_read", { ref })).rejects.toThrow(/cross-conversation/);
    await expect(run(tools, "history_read", { ref: "same-id" })).rejects.toThrow(/Invalid/);
    await expect(run(tools, "history_read", { ref: mutateToken(ref, { i: "missing" }) })).rejects.toThrow(/target unavailable/);
    await expect(run(tools, "history_read", { ref: mutateToken(ref, { extra: "unknown" }) })).rejects.toThrow(/Invalid/);
    branch = [];
    await expect(run(tools, "history_read", { ref })).rejects.toThrow(/rewind/);
  });

  it("fresh snapshots see appends while existing search/read/context continuations keep their frozen upper bound", async () => {
    const { manager, tools } = harness();
    const first = user(manager, "old first"); user(manager, "old second");
    const page = await run(tools, "history_search", { type: "user", maxHits: 1 });
    user(manager, "new future");
    manager.appendContextEdit(first, null); // reset-like provider omission, not raw deletion
    const older = await follow(tools, page.nextCall);
    expect(older.hits.map((hit: Data) => hit.snippet)).toEqual(["old first"]);
    expect((await run(tools, "history_read", { ref: page.hits[0].ref })).text).toBe("old second");
    const window = await run(tools, "history_context", { ref: page.hits[0].ref });
    expect(window.items.map((item: Data) => item.text)).toEqual(["old first", "old second"]);
    expect((await run(tools, "history_search", { type: "user", maxHits: 1 })).hits[0].snippet).toBe("new future");
    await expect(run(tools, "history_search", { ...page.nextCall.args, type: "user" })).rejects.toThrow(/cursor-only/);
    await expect(run(tools, "history_read", page.nextCall.args)).rejects.toThrow(/Invalid/);
  });

  it("filters types exactly and matches literal case-insensitively, never regex", async () => {
    const { manager, tools } = harness();
    user(manager, "İ prefix FOO.* [X]");
    assistant(manager, [{ type: "text", text: "assistant unrelated" }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "FOO.* [X]" }, thoughtSignature: "SIGNATURE" }]);
    result(manager, "tool output FOO.* [X]");
    const exact = await run(tools, "history_search", { type: "user", query: "foo.* [x]" });
    expect(exact.hits).toHaveLength(1); expect(exact.hits[0].snippet).toContain("FOO.* [X]");
    const focused = await run(tools, "history_read", { ref: exact.hits[0].ref });
    expect(focused.text).toContain("FOO.* [X]");
    expect((await run(tools, "history_search", { type: "user", query: "F.O" })).hits).toEqual([]);
    expect((await run(tools, "history_search", { type: "assistant", query: "FOO" })).hits).toEqual([]);
    expect((await run(tools, "history_search", { type: "tool_call", query: "foo.*", toolName: "bash" })).hits).toHaveLength(1);
    expect((await run(tools, "history_search", { type: "tool_result", query: "foo.*", toolName: "other" })).hits).toEqual([]);
  });

  it("caps broad directory/search results and does not invent totals or absence on partial zero-hit scans", async () => {
    const { manager, tools } = harness();
    for (let index = 0; index < 1200; index += 1) user(manager, `第${index}条的记录`);
    const broad = await run(tools, "history_search", { type: "user", query: "的" });
    expect(broad.hits).toHaveLength(10); expect(broad.totalMatches).toBeNull(); expect(broad.scanComplete).toBe(false);
    expect((await run(tools, "history_search", { type: "user", maxHits: 20 })).hits).toHaveLength(20);
    const empty = await run(tools, "history_search", { type: "user", query: "不存在的短语" });
    expect(empty.hits).toEqual([]); expect(empty.scanComplete).toBe(false); expect(empty.stopReason).toBe("scan_budget");
    expect(empty.scan.entries).toBe(HISTORY_SCAN_ENTRIES); expect(empty.nextCall).not.toBeNull();
    let last = empty; let pages = 1;
    while (last.nextCall) { last = await follow(tools, last.nextCall); pages += 1; }
    expect(pages).toBeGreaterThan(1); expect(last.scanComplete).toBe(true); expect(last.totalMatches).toBeNull();
  });

  it("resumes within giant single-line/NUL text and finds a boundary-spanning literal beyond the scan budget", async () => {
    const { manager, tools } = harness();
    const text = "\0".repeat(HISTORY_SCAN_CHARACTERS * 2 + 4090) + "Boundary NEEDLE" + "x".repeat(600);
    user(manager, text);
    let page = await run(tools, "history_search", { type: "user", query: "boundary needle" });
    expect(page.hits).toEqual([]); expect(page.scanComplete).toBe(false);
    let pages = 1;
    while (!page.hits.length && page.nextCall) {
      expect(page.scan.characters).toBeLessThanOrEqual(HISTORY_SCAN_CHARACTERS);
      page = await follow(tools, page.nextCall);
      if (++pages > 10) throw new Error("Search failed to progress");
    }
    expect(pages).toBeGreaterThan(2); expect(page.hits).toHaveLength(1);
    expect((await run(tools, "history_read", { ref: page.hits[0].ref })).text).toContain("Boundary NEEDLE");
  });

  it("accounts for final JSON escape bytes rather than raw string size and paginates all original text", async () => {
    const { manager, tools } = harness();
    const original = ("\0\n\\\"😀".repeat(10000)) + "THE END";
    user(manager, original);
    const ref = (await run(tools, "history_search", { type: "user" })).hits[0].ref;
    expect(await readAll(tools, ref)).toBe(original);
    const zeros = await run(tools, "history_search", { type: "user", query: "\0" });
    expect(zeros.hits).toHaveLength(1);
  });

  it("supports backward/forward original-text cursor navigation from a middle search focus", async () => {
    const { manager, tools } = harness();
    const original = "a".repeat(20000) + "MIDPOINT" + "b".repeat(20000);
    user(manager, original);
    const ref = (await run(tools, "history_search", { type: "user", query: "midpoint" })).hits[0].ref;
    const middle = await run(tools, "history_read", { ref });
    expect(middle.range.offset).toBeGreaterThan(0); expect(middle.text).toContain("MIDPOINT");
    const previous = await follow(tools, middle.olderCall);
    expect(previous.range.endOffset).toBe(middle.range.offset);
    expect(previous.text).toBe(original.slice(previous.range.offset, previous.range.endOffset));
    const back = await follow(tools, previous.newerCall);
    expect(back.range.offset).toBe(middle.range.offset); expect(back.text).toBe(middle.text);
    let first = previous;
    while (first.olderCall) first = await follow(tools, first.olderCall);
    expect(first.range.offset).toBe(0);
  });

  it("keeps giant neighboring tool-result slots and subsequent short user correction/assistant decision in context", async () => {
    const { manager, tools } = harness();
    assistant(manager, [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "old command" } }]);
    const huge = result(manager, "p".repeat(4 * 1024 * 1024) + "TAIL");
    const target = user(manager, "target T2");
    const correction = user(manager, "改口：不要执行旧命令。");
    const decision = assistant(manager, [{ type: "text", text: "历史决定：采用新方案。" }]);
    const ref = (await run(tools, "history_search", { type: "user", query: "target T2" })).hits[0].ref;
    const window = await run(tools, "history_context", { ref, before: 2, after: 2 });
    expect(window.entrySequenceComplete).toBe(true); expect(window.entryTextComplete).toBe(false);
    expect(window.items.map((item: Data) => item.entryId)).toContain(huge);
    expect(window.items.map((item: Data) => item.entryId)).toEqual(expect.arrayContaining([target, correction, decision]));
    expect(window.items.filter((item: Data) => item.target).map((item: Data) => item.entryId)).toEqual([target]);
    const log = window.items.find((item: Data) => item.entryId === huge);
    expect(log.text).toContain("TAIL"); expect(log.range.offset).toBeGreaterThan(0); expect(log.entryTextComplete).toBe(false);
    expect(log.olderCall.tool).toBe("history_read");
    const olderText = await follow(tools, log.olderCall);
    expect(olderText.range.endOffset).toBe(log.range.offset);
    expect(log.related.links).toHaveLength(1);
    expect((await run(tools, "history_read", { ref: log.related.links[0].toolCallRef })).text).toContain("bash");
    expect(window.items.find((item: Data) => item.entryId === correction).text).toContain("不要执行旧命令");
  });

  it("provides chronological older/newer window calls without inheriting a search type filter", async () => {
    const { manager, tools } = harness();
    for (let index = 0; index < 10; index += 1) {
      if (index % 2) assistant(manager, [{ type: "text", text: `assistant ${index}` }]); else user(manager, `user ${index}`);
    }
    const ref = (await run(tools, "history_search", { type: "user", query: "user 4" })).hits[0].ref;
    const window = await run(tools, "history_context", { ref, before: 1, after: 1 });
    expect(window.items.map((item: Data) => item.text)).toEqual(["assistant 3", "user 4", "assistant 5"]);
    const older = await follow(tools, window.olderCall);
    expect(older.items.map((item: Data) => item.text)).toEqual(["user 2", "assistant 3"]);
    const newer = await follow(tools, window.newerCall);
    expect(newer.items.map((item: Data) => item.text)).toEqual(["assistant 5", "user 6"]);
  });

  it("reports incomplete context sequences and advances through excluded metadata without losing an eligible neighbor", async () => {
    const { manager, tools } = harness();
    const old = user(manager, "older allowed neighbor");
    for (let index = 0; index < 400; index += 1) manager.appendCustomEntry("non-context", { data: "PRIVATE" });
    user(manager, "target");
    const ref = (await run(tools, "history_search", { type: "user", query: "target" })).hits[0].ref;
    let window = await run(tools, "history_context", { ref, before: 1, after: 0 });
    expect(window.entrySequenceComplete).toBe(false); expect(window.items).toHaveLength(1);
    let calls = 0;
    while (!window.items.some((item: Data) => item.entryId === old)) {
      window = await follow(tools, window.olderCall);
      if (++calls > 8) throw new Error("Window cursor failed to progress");
    }
    expect(window.items[0].text).toBe("older allowed neighbor");
  });

  it("excludes system/thinking/signatures/host metadata and requires explicit scoped normalized image reads", async () => {
    const { manager, tools } = harness();
    const imageData = Buffer.from("BASE64_SECRET").toString("base64");
    manager.appendMessage({ role: "system", content: "SYSTEM_SECRET", sections: { private: "SYSTEM_SECTION" }, toolsAdded: [], timestamp: 1 });
    manager.appendCustomEntry("host.receipt", { token: "RECEIPT_SECRET" });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "visible user", textSignature: "TEXT_SIGNATURE" }, { type: "image", data: imageData, mimeType: "image/png" }], timestamp: 2 });
    assistant(manager, [{ type: "thinking", thinking: "THINKING_SECRET", thinkingSignature: "THINKING_SIGNATURE" }, { type: "text", text: "visible assistant", textSignature: "ASSISTANT_SIGNATURE" }, { type: "toolCall", id: "call-1", name: "inspect", arguments: { image: { type: "image", data: "ARG_IMAGE_SECRET", mimeType: "image/png" }, text: "visible args" }, thoughtSignature: "THOUGHT_SIGNATURE" }]);
    manager.appendMessage({ role: "toolResult", toolName: "inspect", toolCallId: "call-1", content: [{ type: "text", text: "visible output" }, { type: "image", data: "RESULT_BASE64_SECRET", mimeType: "image/jpeg" }], details: { key: "DETAIL_SECRET" }, isError: false, timestamp: 3 });
    const ref = (await run(tools, "history_search", { type: "user", query: "visible user" })).hits[0].ref;
    const window = await run(tools, "history_context", { ref });
    expect(JSON.stringify(window)).not.toMatch(/SYSTEM_SECRET|SYSTEM_SECTION|RECEIPT_SECRET|TEXT_SIGNATURE|THINKING_SECRET|THINKING_SIGNATURE|ASSISTANT_SIGNATURE|THOUGHT_SIGNATURE|ARG_IMAGE_SECRET|RESULT_BASE64_SECRET|BASE64_SECRET|DETAIL_SECRET/);
    const image = window.items.find((item: Data) => item.role === "user").images[0];
    expect(image.imageOrdinal).toBe(0);
    expect(JSON.stringify(window)).not.toContain(imageData);
    expect(image.imageCall).toEqual({ name: "history_read", arguments: { ref: image.ref, image: true } });
    const normalized = { data: Buffer.from("normalized image").toString("base64"), mimeType: "image/jpeg", width: 2000, height: 1000, originalWidth: 4000, originalHeight: 2000, wasResized: true };
    vi.mocked(resizeImage).mockResolvedValue(normalized);
    const evidence = await run(tools, image.imageCall.name, image.imageCall.arguments);
    expect(evidence.computerCoordinatesAuthorized).toBe(false);
    expect(evidence.evidence).toMatch(/不授予 computer/);
    expect(JSON.stringify(evidence)).not.toContain(normalized.data);
    expect(resizeImage).toHaveBeenCalledWith(Buffer.from(imageData, "base64"), "image/png", { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 });
    expect((await run(tools, "history_read", { ref: image.ref })).text).toContain("[image:0]");
    const other = createHistoryTools({ conversationId: "other", getBranch: () => manager.getBranch() });
    await expect(run(other, "history_read", { ref: image.ref, image: true })).rejects.toThrow(/cross-conversation/);
    await expect(run(tools, "history_read", { ref, image: true })).rejects.toThrow(/image reference/);
    await expect(run(tools, "history_read", { cursor: "any", image: true })).rejects.toThrow(/cursor cannot include image/);
    await expect(run(tools, "history_read", { ref, image: false })).rejects.toThrow(/requires initial/);
  });

  it("excludes direct history outputs and known/structured provider dumps, without claiming DLP for ordinary codemode text", async () => {
    const { manager, tools } = harness();
    for (const name of ["history_search", "history_context", "history_read", "rawcontext_dump", "provider_history_dump"]) result(manager, "FORBIDDEN_REPLAY", name);
    result(manager, JSON.stringify({ messages: [{ role: "system", content: "PROVIDER_SYSTEM_SECRET" }] }), "read");
    result(manager, "ordinary codemode text remains searchable", "codemode");
    expect((await run(tools, "history_search", { type: "tool_result", query: "FORBIDDEN_REPLAY" })).hits).toEqual([]);
    expect((await run(tools, "history_search", { type: "tool_result", query: "PROVIDER_SYSTEM_SECRET" })).hits).toEqual([]);
    expect((await run(tools, "history_search", { type: "tool_result", query: "ordinary codemode" })).hits).toHaveLength(1);
  });

  it("paginates serialized tool arguments including long scalar strings without exposing block signatures", async () => {
    const { manager, tools } = harness();
    const args = { command: "x".repeat(4095) + "😀" + "x".repeat(20000), count: 3 };
    assistant(manager, [{ type: "toolCall", id: "c", name: "bash", arguments: args, thoughtSignature: "OPAQUE_SECRET" }]);
    const ref = (await run(tools, "history_search", { type: "tool_call" })).hits[0].ref;
    expect(await readAll(tools, ref)).toBe(`bash ${JSON.stringify(args)}`);
  });

  it("paginates search hits at the final escaped-JSON byte cap without losing a candidate", async () => {
    const { manager, tools } = harness();
    const ids: string[] = [];
    for (let index = 0; index < 24; index += 1) ids.push(user(manager, "\0".repeat(300)));
    let page = await run(tools, "history_search", { type: "user", maxHits: 20 });
    expect(page.stopReason).toBe("output_budget"); expect(page.hits.length).toBeLessThan(20);
    const found: string[] = [];
    for (;;) {
      found.push(...page.hits.map((hit: Data) => hit.entryId));
      if (!page.nextCall) break;
      page = await follow(tools, page.nextCall);
    }
    expect(found).toEqual(ids.reverse());
  });

  it("rejects image normalization failure, oversized inputs/output, and invalid geometry/mime", async () => {
    const { manager, tools } = harness();
    manager.appendMessage({ role: "user", content: [{ type: "image", data: "UE5H", mimeType: "image/png" }], timestamp: 1 });
    const ref = (await run(tools, "history_search", { type: "user" })).hits[0].ref;
    const marker = (await run(tools, "history_read", { ref })).images[0].ref;
    const normal = { data: "UE5H", mimeType: "image/png", width: 1, height: 1, originalWidth: 1, originalHeight: 1, wasResized: false };
    for (const value of [null, { ...normal, width: 2001 }, { ...normal, height: 0 }, { ...normal, mimeType: "image/svg+xml" }, { ...normal, data: "A".repeat(4.5 * 1024 * 1024) }]) {
      vi.mocked(resizeImage).mockResolvedValueOnce(value);
      await expect(run(tools, "history_read", { ref: marker, image: true })).rejects.toThrow(/normalized/);
    }
    vi.mocked(resizeImage).mockRejectedValueOnce(new Error("decoder failed"));
    await expect(run(tools, "history_read", { ref: marker, image: true })).rejects.toThrow(/normalized/);
    manager.appendMessage({ role: "user", content: [{ type: "image", data: Buffer.alloc(MAX_CONVERSATION_IMAGE_BYTES + 1).toString("base64"), mimeType: "image/png" }], timestamp: 2 });
    const bigRef = (await run(tools, "history_search", { type: "user", maxHits: 1 })).hits[0].ref;
    const bigMarker = (await run(tools, "history_read", { ref: bigRef })).images[0].ref;
    const before = vi.mocked(resizeImage).mock.calls.length;
    await expect(run(tools, "history_read", { ref: bigMarker, image: true })).rejects.toThrow(/safety bound/);
    expect(resizeImage).toHaveBeenCalledTimes(before);
  });

  it("reads a real valid 1px GIF through the public SDK normalizer without rejecting its original supported MIME", async () => {
    const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
    vi.mocked(resizeImage).mockImplementation(actual.resizeImage);
    const { manager, tools } = harness();
    const data = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    manager.appendMessage({ role: "user", content: [{ type: "image", data, mimeType: "image/gif" }], timestamp: 1 });
    const hit = (await run(tools, "history_search", { type: "user", query: "image:0" })).hits[0];
    expect(hit.imageCall).toEqual({ name: "history_read", arguments: { ref: hit.ref, image: true } });
    const tool = tools.find((item) => item.name === "history_read")!;
    const value = await tool.execute("image", hit.imageCall.arguments, undefined, undefined, undefined as never);
    expect(value.content).toHaveLength(2);
    expect(value.content[1]).toEqual({ type: "image", data, mimeType: "image/gif" });
    const evidence = JSON.parse((value.content[0] as { type: "text"; text: string }).text);
    expect(evidence.width).toBe(1); expect(evidence.height).toBe(1);
    expect(evidence.computerCoordinatesAuthorized).toBe(false);
    expect(JSON.stringify(value.details)).not.toContain(data);
  });

  it("revalidates image branch membership after awaited normalization and does not replay removed pixels", async () => {
    const { manager, tools } = harness();
    const root = user(manager, "root");
    manager.appendMessage({ role: "user", content: [{ type: "image", data: "UE5H", mimeType: "image/png" }], timestamp: 2 });
    const ref = (await run(tools, "history_search", { type: "user", maxHits: 1 })).hits[0].ref;
    const marker = (await run(tools, "history_read", { ref })).images[0].ref;
    let settle!: (value: Awaited<ReturnType<typeof resizeImage>>) => void;
    vi.mocked(resizeImage).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const reading = run(tools, "history_read", { ref: marker, image: true });
    manager.branch(root);
    settle({ data: "UE5H", mimeType: "image/png", width: 1, height: 1, originalWidth: 1, originalHeight: 1, wasResized: false });
    await expect(reading).rejects.toThrow(/branch/);
  });

  it("pages many image markers with imageCalls rather than silently dropping image ordinals", async () => {
    const { manager, tools } = harness();
    manager.appendMessage({ role: "user", content: Array.from({ length: 60 }, () => ({ type: "image" as const, data: "UE5H", mimeType: "image/png" })), timestamp: 1 });
    const ref = (await run(tools, "history_search", { type: "user" })).hits[0].ref;
    let page = await run(tools, "history_read", { ref });
    const ordinals = new Set<number>();
    for (;;) {
      for (const image of page.images) { ordinals.add(image.imageOrdinal); expect(image.imageCall.arguments.image).toBe(true); }
      if (!page.nextCall) break;
      page = await follow(tools, page.nextCall);
    }
    expect([...ordinals]).toEqual(Array.from({ length: 60 }, (_, index) => index));
  });

  it("reads the source afresh and honors pre-aborted calls before snapshot access", async () => {
    let branch: SessionEntry[] = [];
    const getBranch = vi.fn(() => branch);
    const tools = createHistoryTools({ conversationId: "a", getBranch });
    expect((await run(tools, "history_search", { type: "user" })).hits).toEqual([]);
    branch = [{ type: "message", id: "added", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "fresh", timestamp: 1 } }];
    expect((await run(tools, "history_search", { type: "user" })).hits[0].snippet).toBe("fresh");
    const abort = new AbortController(); abort.abort();
    await expect(tools[0].execute("id", { type: "user" } as never, abort.signal, undefined, undefined as never)).rejects.toThrow(/aborted/);
    expect(getBranch).toHaveBeenCalledTimes(2);
  });
});
