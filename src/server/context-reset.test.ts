import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { appendContextReset, assertContextResetBoundary, prepareContextReset } from "./context-reset.js";
import { CONVERSATION_MESSAGE_CUSTOM_TYPE, FORK_CONTEXT_CUSTOM_TYPE } from "./conversation-meta.js";

function call(manager: SessionManager, id = "reset-call", extra = false) {
  return manager.appendMessage({
    role: "assistant", content: [
      { type: "toolCall", id, name: "reset_context", arguments: { handoff: "Continue tests; do not repeat the write." } },
      ...(extra ? [{ type: "toolCall" as const, id: "other", name: "bash", arguments: { command: "echo changed" } }] : []),
    ],
    api: "openai-responses", provider: "test", model: "test", timestamp: 1, stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } satisfies AssistantMessage);
}
function result(manager: SessionManager, id = "reset-call") {
  manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "reset_context",
    content: [{ type: "text", text: "accepted, not committed" }], isError: false, timestamp: 2 });
}
function fixture() {
  const manager = SessionManager.inMemory("/test");
  manager.appendMessage({ role: "user", content: "Only investigate; do not change files.", timestamp: 0 });
  const observedLeafId = manager.getLeafId();
  call(manager);
  const input = { observedLeafId, toolCallId: "reset-call", handoff: "Continue tests; do not repeat the write.", runId: "run" };
  return { manager, input };
}

describe("context reset", () => {
  it("keeps instructions and a handoff but unloads old working messages without deleting entries", () => {
    const { manager, input } = fixture();
    const plan = prepareContextReset(manager, input);
    result(manager);
    const physicalIds = manager.getEntries().map(({ id }) => id);
    assertContextResetBoundary(manager, plan);
    const id = appendContextReset(manager, plan, 200);
    expect(manager.getBranch().map(({ id }) => id)).toEqual([...physicalIds, id]);
    const messages = manager.buildSessionProjection().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "compactionSummary" });
    expect(JSON.stringify(messages)).toContain("Only investigate; do not change files.");
    expect(JSON.stringify(messages)).toContain(input.handoff);
    expect(JSON.stringify(messages)).not.toContain("accepted, not committed");
    const entry = manager.getEntry(id);
    expect(entry).toMatchObject({ type: "compaction", firstKeptEntryId: id });
  });

  it("does not nest an old handoff into subsequent protected instructions", () => {
    const { manager, input } = fixture();
    const first = prepareContextReset(manager, input);
    result(manager);
    appendContextReset(manager, first, 200);
    manager.appendMessage({ role: "user", content: "Now explain the result; still do not edit.", timestamp: 3 });
    const observedLeafId = manager.getLeafId();
    call(manager, "second");
    const next = prepareContextReset(manager, { ...input, observedLeafId, toolCallId: "second", handoff: "Answer the question." });
    expect(next.instructions).toContain("Only investigate");
    expect(next.instructions).toContain("Now explain");
    expect(next.instructions).not.toContain(input.handoff);
    expect(next.summary).not.toContain(input.handoff);
  });

  it("preserves existing native summaries and respects canonical user replacements", () => {
    const manager = SessionManager.inMemory("/test");
    const old = manager.appendMessage({ role: "user", content: "old omitted instruction", timestamp: 1 });
    manager.appendCompaction("Carry forward: use the isolated branch.", null, 12);
    const current = manager.appendMessage({ role: "user", content: "original user text", timestamp: 2 });
    manager.appendContextEdit(current, { content: "Effective corrected user text" });
    const observedLeafId = manager.getLeafId();
    call(manager);
    const plan = prepareContextReset(manager, { observedLeafId, toolCallId: "reset-call", handoff: "Next step", runId: "run" });
    expect(plan.instructions).toContain("Carry forward: use the isolated branch.");
    expect(plan.instructions).toContain("Effective corrected user text");
    expect(plan.instructions).not.toContain("original user text");
    expect(plan.instructions).not.toContain("old omitted instruction");
    expect(manager.getEntry(old)).toBeDefined();
  });

  it("refuses mixed calls and nested call IDs before accepting", () => {
    const { manager, input } = fixture();
    expect(() => prepareContextReset(manager, { ...input, toolCallId: "outer/nested" })).toThrow(/only direct/);
    const observedLeafId = manager.getLeafId();
    call(manager, "mixed", true);
    expect(() => prepareContextReset(manager, { ...input, observedLeafId, toolCallId: "mixed" })).toThrow(/only direct/);
  });

  it("rejects new context during generation or after the tool result, but allows host metadata", () => {
    const { manager, input } = fixture();
    manager.appendCustomMessageEntry("extension-note", "unseen input", false);
    expect(() => prepareContextReset(manager, input)).toThrow(/new context/);
    const second = fixture();
    const plan = prepareContextReset(second.manager, second.input);
    result(second.manager);
    second.manager.appendCustomEntry("some-metadata", { unchanged: true });
    expect(() => assertContextResetBoundary(second.manager, plan)).not.toThrow();
    second.manager.appendCustomMessageEntry("extension-note", "flushed at turn_end", false);
    expect(() => assertContextResetBoundary(second.manager, plan)).toThrow(/additional context/);
  });

  it("refuses empty/oversized handoffs, oversized instructions and preserved user images", () => {
    const { manager, input } = fixture();
    expect(() => prepareContextReset(manager, { ...input, handoff: " " })).toThrow(/non-empty/);
    expect(() => prepareContextReset(manager, { ...input, handoff: "中".repeat(3000) })).toThrow(/8 KiB/);
    const big = SessionManager.inMemory("/test");
    big.appendMessage({ role: "user", content: "x".repeat(131072), timestamp: 1 });
    const observedLeafId = big.getLeafId();
    call(big);
    expect(() => prepareContextReset(big, { ...input, observedLeafId })).toThrow(/128 KiB/);
    const images = SessionManager.inMemory("/test");
    images.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: 1 });
    const imageLeaf = images.getLeafId();
    call(images);
    expect(() => prepareContextReset(images, { ...input, observedLeafId: imageLeaf })).toThrow(/images/);
  });

  it("preserves peer/extension input but not host progress hints, including a hint written after prepareRequest", () => {
    const manager = SessionManager.inMemory("/test");
    manager.appendCustomMessageEntry("peer-task", "Investigate only. Report to the lead.", false);
    const observedLeafId = manager.getLeafId();
    manager.appendCustomMessageEntry("piweb.context_hint.v1", "old transient telemetry", false);
    call(manager);
    const input = { observedLeafId, toolCallId: "reset-call", handoff: "Continue investigation", runId: "run" };
    const plan = prepareContextReset(manager, input);
    expect(plan.instructions).toContain("Investigate only. Report to the lead.");
    expect(plan.instructions).not.toContain("transient telemetry");
    expect(() => prepareContextReset(manager, { ...input, contextBudget: 1 })).toThrow(/context budget/);
    expect(() => prepareContextReset(manager, { ...input, contextBudget: 10000 })).not.toThrow();
  });

  it("unloads peer reports and fork context instead of replaying them as preserved instructions", () => {
    const manager = SessionManager.inMemory("/test");
    manager.appendMessage({ role: "user", content: "Keep the wire format stable.", timestamp: 0 });
    const body = "report body ".repeat(6000);
    for (const index of [1, 2, 3]) {
      manager.appendCustomMessageEntry(CONVERSATION_MESSAGE_CUSTOM_TYPE, `Report ${index}\n${body}`, true);
    }
    manager.appendCustomMessageEntry(FORK_CONTEXT_CUSTOM_TYPE, "Forked from the parent conversation.", false);
    const observedLeafId = manager.getLeafId();
    call(manager);
    const handoff = "Continue with the parse fix.";
    const plan = prepareContextReset(manager, { observedLeafId, toolCallId: "reset-call", handoff, runId: "run" });
    expect(plan.instructions).toContain("Keep the wire format stable.");
    expect(plan.instructions).not.toContain("report body");
    expect(plan.instructions).not.toContain("Forked from");
    expect(plan.reports).toMatch(/4 peer\/session report message/);
    expect(plan.reports).toContain("history_search");
    result(manager);
    appendContextReset(manager, plan, 200);
    const live = manager.buildSessionProjection().messages.map((message) => JSON.stringify(message)).join("\n");
    expect(live).toContain("Unloaded report context (not instructions)");
    expect(live).toContain("Keep the wire format stable.");
    expect(live).not.toContain("report body");
    expect(live).not.toContain("Forked from");
  });

  it("does not treat an image inside a peer report as protected user input", () => {
    const manager = SessionManager.inMemory("/test");
    manager.appendMessage({ role: "user", content: "Use the teammate's screenshot, then fix the parser.", timestamp: 0 });
    manager.appendCustomMessageEntry(CONVERSATION_MESSAGE_CUSTOM_TYPE,
      [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], true);
    const observedLeafId = manager.getLeafId();
    call(manager);
    const plan = prepareContextReset(manager, {
      observedLeafId, toolCallId: "reset-call", handoff: "Continue the parse fix.", runId: "run",
    });
    expect(plan.instructions).toContain("Use the teammate's screenshot");
    expect(plan.reports).toMatch(/1 peer\/session report message/);
  });

  it("keeps a report note verifiable without carrying it into the next checkpoint", () => {
    const manager = SessionManager.inMemory("/test");
    manager.appendMessage({ role: "user", content: "Fix the parser.", timestamp: 0 });
    manager.appendCustomMessageEntry(CONVERSATION_MESSAGE_CUSTOM_TYPE, "first report body", true);
    const firstLeaf = manager.getLeafId();
    call(manager, "first");
    const first = prepareContextReset(manager, {
      observedLeafId: firstLeaf, toolCallId: "first", handoff: "Next: parse.", runId: "run",
    });
    result(manager, "first");
    appendContextReset(manager, first, 100);
    manager.appendMessage({ role: "user", content: "Also keep the CLI flag.", timestamp: 3 });
    manager.appendCustomMessageEntry(CONVERSATION_MESSAGE_CUSTOM_TYPE, "second report body", true);
    const secondLeaf = manager.getLeafId();
    call(manager, "second");
    const next = prepareContextReset(manager, {
      observedLeafId: secondLeaf, toolCallId: "second", handoff: "Continue.", runId: "run",
    });
    expect(next.instructions).toContain("Fix the parser.");
    expect(next.instructions).toContain("Also keep the CLI flag.");
    expect(next.instructions).not.toContain("first report body");
    expect(next.instructions).not.toContain("Unloaded report context");
    expect(next.reports).toMatch(/1 peer\/session report message/);
  });

  it("refuses a second reset without intervening work", () => {
    const { manager, input } = fixture();
    const plan = prepareContextReset(manager, input);
    result(manager);
    appendContextReset(manager, plan, 100);
    const observedLeafId = manager.getLeafId();
    call(manager, "again");
    expect(() => prepareContextReset(manager, { ...input, observedLeafId, toolCallId: "again" })).toThrow(/new work/);
  });
});
