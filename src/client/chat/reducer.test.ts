import { describe, expect, it, vi } from "vitest";
import type {
  ConversationHistoryItem,
  ConversationMessageCard,
  TokenUsage,
} from "../../shared/protocol";
import {
  chatReducer,
  initialChatState,
  type ChatMessageItem,
  type ChatState,
} from "./reducer";

const RUN_1 = "run-1";
const RUN_2 = "run-2";
const FOCUS_A_1 = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  conversationId: "conversation-a",
  focusId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
};
const FOCUS_A_2 = {
  ...FOCUS_A_1,
  focusId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
};
const FOCUS_B = {
  sessionId: FOCUS_A_1.sessionId,
  conversationId: "conversation-b",
  focusId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

function usage(total: number): TokenUsage {
  return {
    input: total,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total,
  };
}

function historyMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  total = 0,
): ConversationHistoryItem {
  return {
    kind: "message",
    id,
    role,
    text,
    thinking: "",
    tools: [],
    ...(total > 0 ? { usage: usage(total) } : {}),
  };
}

function messageItems(state: ChatState): ChatMessageItem[] {
  return state.items.filter((item): item is ChatMessageItem => (
    item.kind === "message"
  ));
}

function focusedState(focus = FOCUS_A_1): ChatState {
  return chatReducer(initialChatState, {
    type: "focus_changed",
    ...focus,
  });
}

function sessionMessageCard(
  state: ConversationMessageCard["state"] = "queued",
): ConversationMessageCard {
  return {
    kind: "session_message",
    id: `entry-${state}`,
    cardId: "card-1",
    direction: "outgoing",
    state,
    body: "review the recovery path",
    from: {
      conversationId: "conversation-a",
      title: "lead",
      role: { id: "lead", name: "Lead" },
    },
    to: {
      conversationId: "conversation-b",
      title: "review",
      role: { id: "reviewer", name: "Reviewer" },
    },
    sentAt: "2026-07-19T08:00:00.000Z",
    updatedAt: "2026-07-19T08:01:00.000Z",
    ...(state === "completed" ? { result: "all good" } : {}),
  };
}

describe("chatReducer", () => {
  it("hydrates message and session-message items only for the attached focus", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      items: [
        historyMessage("user-1", "user", "inspect"),
        sessionMessageCard(),
        historyMessage("assistant-1", "assistant", "done", 9),
      ],
    });

    expect(state.focus).toEqual(FOCUS_A_1);
    expect(state.items.map((item) => item.kind)).toEqual([
      "message",
      "session_message",
      "message",
    ]);
    expect(messageItems(state).map(({ id }) => id)).toEqual(["user-1", "assistant-1"]);
    expect(messageItems(state).at(-1)?.usage?.total).toBe(9);
  });

  it("replaces authoritative history coverage and preserves it across live items", () => {
    const incompleteWindow = {
      omittedBefore: true,
      startsMidTurn: true,
      contentTruncated: true,
    };
    let state = chatReducer(focusedState(), {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 4,
      items: [],
      historyWindow: incompleteWindow,
    });
    state = chatReducer(state, {
      type: "conversation_item",
      ...FOCUS_A_1,
      projectionSeq: 4,
      item: sessionMessageCard(),
    });
    expect(state.historyWindow).toEqual(incompleteWindow);

    const staleIdentity = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_B,
      projectionSeq: 5,
      items: [],
      historyWindow: {
        omittedBefore: false,
        startsMidTurn: false,
        contentTruncated: false,
      },
    });
    expect(staleIdentity).toBe(state);

    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 4,
      items: [],
      historyWindow: {
        omittedBefore: false,
        startsMidTurn: false,
        contentTruncated: false,
      },
    });
    expect(state.historyWindow).toEqual({
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    });

    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 4,
      items: [],
    });
    expect(state.historyWindow).toBeUndefined();
  });

  it("clears history coverage on same or changed focus and reset", () => {
    const hydrate = (state: ChatState, focus = FOCUS_A_1) => chatReducer(state, {
      type: "hydrate",
      ...focus,
      items: [],
      historyWindow: {
        omittedBefore: true,
        startsMidTurn: false,
        contentTruncated: false,
      },
    });
    let state = hydrate(focusedState());

    state = chatReducer(state, { type: "focus_changed", ...FOCUS_A_1 });
    expect(state.historyWindow).toBeUndefined();

    state = hydrate(state);
    state = chatReducer(state, { type: "focus_changed", ...FOCUS_B });
    expect(state.historyWindow).toBeUndefined();

    state = hydrate(state, FOCUS_B);
    state = chatReducer(state, { type: "reset" });
    expect(state).toEqual(initialChatState);
  });

  it("normalizes a large unique snapshot with linear identity reads", () => {
    let idReads = 0;
    const items = Array.from({ length: 1_000 }, (_, index) => {
      const item: ConversationHistoryItem = {
        kind: "compaction",
        id: `compaction-${index}`,
        timestamp: "2026-07-19T10:00:00.000Z",
        tokensBefore: index,
      };
      Object.defineProperty(item, "id", {
        configurable: true,
        enumerable: true,
        get: () => {
          idReads += 1;
          return `compaction-${index}`;
        },
      });
      return item;
    });

    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      items,
    });

    expect(state.items).toHaveLength(items.length);
    expect(idReads).toBeLessThanOrEqual(items.length * 2);
  });

  it("hydrates a durable compaction boundary without treating it as a message", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      items: [
        historyMessage("before", "assistant", "before"),
        {
          kind: "compaction",
          id: "compaction-1",
          timestamp: "2026-07-19T10:00:00.000Z",
          tokensBefore: 63_771,
        },
        historyMessage("after", "user", "after"),
      ],
    });

    expect(state.items.map((item) => item.kind)).toEqual([
      "message",
      "compaction",
      "message",
    ]);
    expect(messageItems(state).map(({ id }) => id)).toEqual(["before", "after"]);
  });

  it("clears the old transcript when a new focus is attached", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      items: [historyMessage("user-1", "user", "old")],
    });

    state = chatReducer(state, { type: "focus_changed", ...FOCUS_B });

    expect(state.focus).toEqual(FOCUS_B);
    expect(state.items).toEqual([]);
  });

  it("rejects the first A snapshot after an A to B to A focus cycle", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, { type: "focus_changed", ...FOCUS_B });
    state = chatReducer(state, { type: "focus_changed", ...FOCUS_A_2 });

    const stale = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      items: [historyMessage("stale", "assistant", "stale A")],
    });
    expect(stale).toBe(state);

    const current = chatReducer(stale, {
      type: "hydrate",
      ...FOCUS_A_2,
      items: [historyMessage("current", "assistant", "current A")],
    });
    expect(current.items).toEqual([
      expect.objectContaining({ id: "current", text: "current A" }),
    ]);
  });

  it("hydrates active-run messages with the server runId and applies the next delta in place", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 4,
      items: [{
        kind: "message",
        id: "assistant-live",
        runId: RUN_1,
        role: "assistant",
        text: "hello",
        thinking: "",
        tools: [],
      }],
    });

    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_1,
      runId: RUN_1,
      projectionSeq: 5,
      event: { type: "text_delta", delta: " world" },
    });

    expect(state.projectionGap).toBe(false);
    expect(state.lastProjectionSeq).toBe(5);
    expect(messageItems(state)).toEqual([
      expect.objectContaining({
        id: "assistant-live",
        runId: RUN_1,
        text: "hello world",
      }),
    ]);
  });

  it("does not let an older snapshot roll back a current focus watermark", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 5,
      items: [historyMessage("current", "assistant", "current")],
      historyWindow: {
        omittedBefore: true,
        startsMidTurn: false,
        contentTruncated: false,
      },
    });
    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_1,
      runId: RUN_1,
      projectionSeq: 6,
      event: { type: "text_delta", delta: " state" },
    });

    const stale = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 5,
      items: [historyMessage("stale", "assistant", "stale")],
      historyWindow: {
        omittedBefore: false,
        startsMidTurn: false,
        contentTruncated: false,
      },
    });

    expect(stale).toBe(state);
    expect(stale.historyWindow).toEqual({
      omittedBefore: true,
      startsMidTurn: false,
      contentTruncated: false,
    });
    expect(stale.lastProjectionSeq).toBe(6);
    expect(messageItems(stale).map(({ text }) => text)).toEqual([
      "current",
      " state",
    ]);
  });

  it("rejects projection deltas that arrive before a snapshot or with a sequence gap", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_1,
      runId: RUN_1,
      projectionSeq: 1,
      event: { type: "text_delta", delta: "early" },
    });
    expect(state.projectionGap).toBe(true);
    expect(messageItems(state)).toEqual([]);

    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 2,
      items: [],
    });
    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_1,
      runId: RUN_1,
      projectionSeq: 4,
      event: { type: "text_delta", delta: "gap" },
    });
    expect(state.projectionGap).toBe(true);
    expect(state.lastProjectionSeq).toBe(2);
    expect(messageItems(state)).toEqual([]);

    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_1,
      runId: RUN_1,
      projectionSeq: 3,
      event: { type: "text_delta", delta: "late" },
    });
    expect(state.projectionGap).toBe(true);
    expect(state.lastProjectionSeq).toBe(2);
    expect(messageItems(state)).toEqual([]);
  });

  it("does not let conversation items advance projection sequence over a missing delta", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 5,
      items: [],
    });

    state = chatReducer(state, {
      type: "conversation_item",
      ...FOCUS_A_1,
      projectionSeq: 6,
      item: sessionMessageCard("completed"),
    });

    expect(state.projectionGap).toBe(true);
    expect(state.lastProjectionSeq).toBe(5);
    expect(state.items).toEqual([]);
  });

  it("clears authoritative history coverage on every projection-gap path", () => {
    const incompleteWindow = {
      omittedBefore: true,
      startsMidTurn: false,
      contentTruncated: false,
    };
    const cases: Array<{
      name: string;
      projectionSeq?: number;
      apply(state: ChatState): ChatState;
    }> = [{
      name: "conversation item mismatches an existing watermark",
      projectionSeq: 5,
      apply: (state) => chatReducer(state, {
        type: "conversation_item",
        ...FOCUS_A_1,
        projectionSeq: 6,
        item: sessionMessageCard(),
      }),
    }, {
      name: "conversation item introduces a watermark",
      apply: (state) => chatReducer(state, {
        type: "conversation_item",
        ...FOCUS_A_1,
        projectionSeq: 1,
        item: sessionMessageCard(),
      }),
    }, {
      name: "session event omits an existing watermark",
      projectionSeq: 5,
      apply: (state) => chatReducer(state, {
        type: "session",
        ...FOCUS_A_1,
        runId: RUN_1,
        event: { type: "run_started" },
      }),
    }, {
      name: "session event skips the next watermark",
      projectionSeq: 5,
      apply: (state) => chatReducer(state, {
        type: "session",
        ...FOCUS_A_1,
        runId: RUN_1,
        projectionSeq: 7,
        event: { type: "run_started" },
      }),
    }];

    for (const testCase of cases) {
      const state = chatReducer(focusedState(), {
        type: "hydrate",
        ...FOCUS_A_1,
        items: [],
        ...(testCase.projectionSeq === undefined
          ? {}
          : { projectionSeq: testCase.projectionSeq }),
        historyWindow: incompleteWindow,
      });
      const gapped = testCase.apply(state);
      expect(gapped.projectionGap, testCase.name).toBe(true);
      expect(gapped.historyWindow, testCase.name).toBeUndefined();
    }
  });

  it("accepts equal-watermark conversation items without advancing sequence", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 5,
      items: [historyMessage("before", "user", "before")],
    });

    state = chatReducer(state, {
      type: "conversation_item",
      ...FOCUS_A_1,
      projectionSeq: 5,
      item: sessionMessageCard("completed"),
    });

    expect(state.projectionGap).toBe(false);
    expect(state.lastProjectionSeq).toBe(5);
    expect(state.items.map((item) => item.kind)).toEqual([
      "message",
      "session_message",
    ]);
  });

  it("clears a projection gap with a matching snapshot and applies the next delta", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 5,
      items: [],
    });
    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_1,
      runId: RUN_1,
      projectionSeq: 7,
      event: { type: "text_delta", delta: "gap" },
    });
    expect(state.projectionGap).toBe(true);

    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 7,
      items: [{
        kind: "message",
        id: "assistant-live",
        runId: RUN_1,
        role: "assistant",
        text: "caught up",
        thinking: "",
        tools: [],
      }],
    });
    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_1,
      runId: RUN_1,
      projectionSeq: 8,
      event: { type: "text_delta", delta: " now" },
    });

    expect(state.projectionGap).toBe(false);
    expect(state.lastProjectionSeq).toBe(8);
    expect(messageItems(state)).toEqual([
      expect.objectContaining({ text: "caught up now" }),
    ]);
  });

  it("rejects unsequenced run deltas after a sequenced snapshot", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      projectionSeq: 5,
      items: [],
    });

    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_1,
      runId: RUN_1,
      event: { type: "text_delta", delta: "missing sequence" },
    });

    expect(state.projectionGap).toBe(true);
    expect(state.lastProjectionSeq).toBe(5);
    expect(messageItems(state)).toEqual([]);
  });

  it("updates a live card in place by cardId and preserves its position", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "hydrate",
      ...FOCUS_A_1,
      items: [
        historyMessage("before", "user", "before"),
        sessionMessageCard(),
        historyMessage("after", "assistant", "after"),
      ],
    });

    state = chatReducer(state, {
      type: "conversation_item",
      ...FOCUS_A_1,
      item: sessionMessageCard("completed"),
    });

    expect(state.items).toHaveLength(3);
    expect(state.items[1]).toMatchObject({
      kind: "session_message",
      cardId: "card-1",
      state: "completed",
      result: "all good",
    });
    expect(state.items.map(({ id }) => id)).toEqual([
      "before",
      "entry-completed",
      "after",
    ]);
  });

  it("drops live items and run events with the wrong session, conversation, or focus", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_2,
    });
    const wrongIdentities = [
      { ...FOCUS_A_2, sessionId: "22222222-2222-4222-8222-222222222222" },
      { ...FOCUS_A_2, conversationId: "conversation-b" },
      { ...FOCUS_A_2, focusId: FOCUS_A_1.focusId },
    ];

    for (const identity of wrongIdentities) {
      const before = state;
      state = chatReducer(state, {
        type: "conversation_item",
        ...identity,
        item: sessionMessageCard(),
      });
      expect(state).toBe(before);
      state = chatReducer(state, {
        type: "session",
        ...identity,
        runId: RUN_1,
        event: { type: "text_delta", delta: "stale" },
      });
      expect(state).toBe(before);
    }

    state = chatReducer(state, {
      type: "session",
      ...FOCUS_A_2,
      runId: RUN_1,
      event: { type: "text_delta", delta: "current" },
    });
    expect(messageItems(state)).toEqual([
      expect.objectContaining({ role: "assistant", text: "current" }),
    ]);
  });

  it("projects a scoped accepted prompt once and rejects a stale focus", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_2,
    });
    state = chatReducer(state, {
      type: "prompt_accepted",
      ...FOCUS_A_2,
      runId: RUN_1,
      text: "current",
    });
    const once = state;
    state = chatReducer(state, {
      type: "prompt_accepted",
      ...FOCUS_A_2,
      runId: RUN_1,
      text: "duplicate",
    });
    expect(state).toBe(once);

    state = chatReducer(state, {
      type: "prompt_accepted",
      ...FOCUS_A_1,
      runId: RUN_2,
      text: "stale",
    });
    expect(state).toBe(once);
    expect(messageItems(state)).toEqual([
      expect.objectContaining({ role: "user", runId: RUN_1, text: "current" }),
    ]);
  });

  it("hydrates a detached persistent history snapshot", () => {
    const state = chatReducer(initialChatState, { ...FOCUS_A_1,
      type: "hydrate",
      items: [{
        kind: "message",
        id: "user-1",
        role: "user",
        text: "inspect",
        thinking: "",
        tools: [],
      }, {
        kind: "message",
        id: "assistant-1",
        role: "assistant",
        text: "done",
        thinking: "checking",
        tools: [{
          toolCallId: "tool-1",
          toolName: "read",
          args: { path: "README.md" },
          result: "ok",
          status: "done",
        }],
        usage: {
          input: 2,
          output: 3,
          cacheRead: 4,
          cacheWrite: 0,
          total: 9,
        },
      }],
    });

    expect(messageItems(state).at(-1)?.usage?.total).toBe(9);
    expect(messageItems(state)).toEqual([
      expect.objectContaining({ id: "user-1", role: "user", text: "inspect" }),
      expect.objectContaining({
        id: "assistant-1",
        role: "assistant",
        text: "done",
        tools: [expect.objectContaining({ id: "tool-1", status: "done" })],
      }),
    ]);
  });

  it("projects an accepted prompt once per run identity", () => {
    const accepted = {
      ...FOCUS_A_1,
      type: "prompt_accepted" as const,
      runId: RUN_1,
      text: "hello",
    };
    const once = chatReducer(focusedState(), accepted);
    const twice = chatReducer(once, accepted);

    expect(twice).toBe(once);
    expect(messageItems(twice)).toEqual([
      expect.objectContaining({ role: "user", runId: RUN_1, text: "hello" }),
    ]);
  });

  it("streams assistant text", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_1, text: "hello" });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_1, event: { type: "run_started" } });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_1, event: { type: "text_delta", delta: "hi" } });
    expect(messageItems(state).at(-1)?.text).toBe("hi");
  });

  it("hands a trailing run placeholder the authoritative assistant projection ID", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1,
      type: "prompt_accepted",
      runId: RUN_1,
      text: "hello",
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: { type: "run_started" },
    });
    const placeholderId = messageItems(state).at(-1)?.id;

    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: {
        type: "assistant_message_started",
        projectionId: "assistant-projection-1",
      },
    });

    expect(messageItems(state)).toHaveLength(2);
    expect(messageItems(state).at(-1)).toMatchObject({
      id: "assistant-projection-1",
      role: "assistant",
      runId: RUN_1,
    });
    expect(messageItems(state).at(-1)?.id).not.toBe(placeholderId);
  });

  it("projects an assistant start when no run placeholder exists", () => {
    const state = chatReducer(focusedState(), { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: {
        type: "assistant_message_started",
        projectionId: "assistant-projection-1",
      },
    });

    expect(messageItems(state)).toEqual([
      expect.objectContaining({
        id: "assistant-projection-1",
        role: "assistant",
        runId: RUN_1,
      }),
    ]);
  });

  it("keeps guidance and the following assistant segment in transcript order", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1,
      type: "prompt_accepted",
      runId: RUN_1,
      text: "initial",
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: { type: "run_started" },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: { type: "text_delta", delta: "before" },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: {
        type: "user_message",
        projectionId: "e285717e-e53c-45ec-a40d-0d5f11d8b9d0",
        text: "change direction",
      },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: {
        type: "assistant_message_started",
        projectionId: "095a5c5d-93d6-48e7-9532-ea1e299b7f86",
      },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: { type: "text_delta", delta: "after" },
    });

    expect(messageItems(state).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "initial" },
      { role: "assistant", text: "before" },
      { role: "user", text: "change direction" },
      { role: "assistant", text: "after" },
    ]);
  });

  it("tracks tool lifecycle", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1, type: "session", runId: RUN_1, event: { type: "tool_started", toolCallId: "1", toolName: "read", args: { path: "a" } } });
    expect(messageItems(state).at(-1)?.tools[0]).toMatchObject({
      args: { path: "a" },
      status: "pending",
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: {
        type: "tool_prepared",
        toolCallId: "1",
        args: { path: "changed-by-extension.ts" },
      },
    });
    expect(messageItems(state).at(-1)?.tools[0]).toMatchObject({
      args: { path: "changed-by-extension.ts" },
      status: "pending",
    });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_1, event: { type: "tool_finished", toolCallId: "1", result: { content: [] }, isError: false } });
    expect(messageItems(state).at(-1)?.tools[0].status).toBe("done");
  });

  it("records live assistant parts in arrival order around a session card", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "run_started" },
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "thinking_delta", delta: "Plan the delegation" },
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: {
        type: "tool_started",
        toolCallId: "tool-1",
        toolName: "start_session",
        args: {},
      },
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "conversation_item",
      item: sessionMessageCard(),
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: {
        type: "assistant_message_started",
        projectionId: "assistant-after-card",
      },
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "thinking_delta", delta: "Continue locally" },
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "text_delta", delta: "Finished locally" },
      ...FOCUS_A_1,
    });

    expect(state.items).toEqual([
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        parts: [
          { kind: "thinking", text: "Plan the delegation" },
          { kind: "tool", toolId: "tool-1" },
        ],
      }),
      expect.objectContaining({ kind: "session_message", cardId: "card-1" }),
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        parts: [
          { kind: "thinking", text: "Continue locally" },
          { kind: "text", text: "Finished locally" },
        ],
      }),
    ]);
  });

  it("moves an unused run placeholder past a newly observed timeline boundary", () => {
    let state = chatReducer(initialChatState, {
      type: "focus_changed",
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "run_started" },
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "conversation_item",
      item: sessionMessageCard(),
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: {
        type: "assistant_message_started",
        projectionId: "assistant-after-boundary",
      },
      ...FOCUS_A_1,
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "text_delta", delta: "After the boundary" },
      ...FOCUS_A_1,
    });

    expect(state.items).toEqual([
      expect.objectContaining({ kind: "session_message", cardId: "card-1" }),
      expect.objectContaining({
        kind: "message",
        id: "assistant-after-boundary",
        text: "After the boundary",
      }),
    ]);
  });

  it("accumulates assistant total token usage as session tokens", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_1, text: "hello" });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_1, event: { type: "run_started" } });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_1, event: { type: "usage", usage: usage(25) } });

    state = chatReducer(state, { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_2, text: "hello again" });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_2, event: { type: "run_started" } });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_2, event: { type: "usage", usage: usage(23) } });

    expect(messageItems(state)
      .filter((message) => message.usage !== undefined)
      .map((message) => message.usage?.total))
      .toEqual([25, 23]);
  });

  it("accumulates usage from multiple assistant calls in one agent run", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_1, text: "use a tool" });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_1, event: { type: "run_started" } });

    for (const total of [25, 23]) {
      state = chatReducer(state, { ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        event: { type: "usage", usage: usage(total) },
      });
    }

    expect(messageItems(state).at(-1)?.usage?.total).toBe(48);
  });

  it("derives a settled average output rate from final usage across assistant segments", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-06T16:00:00.000Z"));
      let state = focusedState();
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        event: { type: "run_started" },
      });
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        event: { type: "assistant_message_started", projectionId: "assistant-1" },
      });
      vi.advanceTimersByTime(1_000);
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        event: {
          type: "usage",
          usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, total: 10 },
        },
      });
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        event: { type: "tool_started", toolCallId: "tool-1", toolName: "read" },
      });
      vi.advanceTimersByTime(4_000);
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        event: { type: "assistant_message_started", projectionId: "assistant-2" },
      });
      vi.advanceTimersByTime(500);
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        event: {
          type: "usage",
          usage: { input: 0, output: 15, cacheRead: 0, cacheWrite: 0, total: 15 },
        },
      });
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        event: { type: "run_finished", outcome: "completed" },
      });

      expect(state.completedOutputRate).toMatchObject({
        runId: RUN_1,
        outputTokens: 25,
        outputElapsedMs: 1_500,
      });
      expect(state.completedOutputRate?.tokensPerSecond).toBeCloseTo(25_000 / 1_500);
      expect(state.outputRateMeasurement).toBeUndefined();

      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_2,
        event: { type: "run_started" },
      });
      expect(state.completedOutputRate).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a settled output rate through its same-sequence completion snapshot", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-06T16:00:00.000Z"));
      let state = chatReducer(focusedState(), {
        ...FOCUS_A_1,
        type: "hydrate",
        projectionSeq: 0,
        items: [],
      });
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        projectionSeq: 1,
        event: { type: "run_started" },
      });
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        projectionSeq: 2,
        event: { type: "assistant_message_started", projectionId: "assistant-1" },
      });
      vi.advanceTimersByTime(1_000);
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        projectionSeq: 3,
        event: {
          type: "usage",
          usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, total: 10 },
        },
      });
      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "session",
        runId: RUN_1,
        projectionSeq: 4,
        event: { type: "run_finished", outcome: "completed" },
      });
      expect(state.completedOutputRate?.tokensPerSecond).toBe(10);

      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "hydrate",
        projectionSeq: 4,
        items: [],
      });
      expect(state.completedOutputRate?.tokensPerSecond).toBe(10);

      state = chatReducer(state, {
        ...FOCUS_A_1,
        type: "hydrate",
        projectionSeq: 5,
        items: [],
      });
      expect(state.completedOutputRate).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the final assistant message when no streaming delta arrived", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_1, text: "hello" });
    state = chatReducer(state, { ...FOCUS_A_1, type: "session", runId: RUN_1, event: { type: "run_started" } });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: { type: "text_replaced", text: "final-only response" },
    });

    expect(messageItems(state).at(-1)?.text).toBe("final-only response");
  });

  it("routes interleaved text to the assistant for each run", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_1, text: "first" });
    state = chatReducer(state, { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_2, text: "second" });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_2,
      event: { type: "text_delta", delta: "second answer" },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: { type: "text_delta", delta: "first answer" },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_2,
      event: { type: "text_delta", delta: "!" },
    });

    expect(messageItems(state).map(({ role, runId, text }) => ({ role, runId, text }))).toEqual([
      { role: "user", runId: RUN_1, text: "first" },
      { role: "assistant", runId: RUN_1, text: "first answer" },
      { role: "user", runId: RUN_2, text: "second" },
      { role: "assistant", runId: RUN_2, text: "second answer!" },
    ]);
  });

  it("routes interleaved tools and usage even when tool call ids overlap", () => {
    let state = chatReducer(focusedState(), { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_1, text: "first" });
    state = chatReducer(state, { ...FOCUS_A_1, type: "prompt_accepted", runId: RUN_2, text: "second" });
    for (const runId of [RUN_2, RUN_1]) {
      state = chatReducer(state, { ...FOCUS_A_1,
        type: "session",
        runId,
        event: { type: "tool_started", toolCallId: "shared", toolName: "read" },
      });
    }
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: { type: "tool_finished", toolCallId: "shared", result: "first result", isError: false },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_2,
      event: { type: "tool_finished", toolCallId: "shared", result: "second result", isError: true },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_2,
      event: { type: "usage", usage: usage(20) },
    });
    state = chatReducer(state, { ...FOCUS_A_1,
      type: "session",
      runId: RUN_1,
      event: { type: "usage", usage: usage(10) },
    });

    const assistants = messageItems(state).filter((message) => message.role === "assistant");
    expect(assistants.find((message) => message.runId === RUN_1)).toMatchObject({
      usage: { total: 10 },
      tools: [{ result: "first result", status: "done" }],
    });
    expect(assistants.find((message) => message.runId === RUN_2)).toMatchObject({
      usage: { total: 20 },
      tools: [{ result: "second result", status: "error" }],
    });
    expect(assistants.reduce((total, message) => total + (message.usage?.total ?? 0), 0)).toBe(30);
  });
});
