// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessageCard } from "../../shared/protocol";
import { SessionMessageCard } from "./SessionMessageCard";

const outgoingCard: ConversationMessageCard = {
  kind: "session_message",
  id: "item-1",
  cardId: "card-1",
  direction: "outgoing",
  state: "queued",
  body: "请检查会话恢复路径。",
  from: {
    conversationId: "source-12345678",
    title: "主控会话",
    role: { id: "lead", name: "负责人" },
  },
  to: {
    conversationId: "target-87654321",
    title: "审查会话",
    role: { id: "reviewer", name: "审查员" },
  },
  sentAt: "2026-07-19T08:00:00.000Z",
  updatedAt: "2026-07-19T08:01:00.000Z",
  messageId: "message-1",
  peerExists: true,
};

afterEach(cleanup);

describe("SessionMessageCard", () => {
  it("renders a compact outgoing summary and hides details by default", () => {
    const { container } = render(<SessionMessageCard card={outgoingCard} />);
    const card = screen.getByRole("article", { name: "发出的会话消息" });

    expect(card).toHaveClass(
      "session-message-card",
      "direction-outgoing",
      "state-queued",
      "is-collapsed",
    );
    expect(card).toHaveAttribute("data-card-id", "card-1");
    expect(within(card).getByText("发出")).toBeInTheDocument();
    expect(within(card).getByRole("status", { name: "消息状态：已排队" })).toHaveTextContent("已排队");
    expect(within(card).getByText("发给 审查会话")).toBeInTheDocument();
    expect(within(card).queryByText("主控会话")).not.toBeInTheDocument();
    expect(within(card).queryByText("请检查会话恢复路径。")).not.toBeInTheDocument();

    fireEvent.click(
      within(card).getByRole("button", {
        name: "展开发出的会话消息：审查会话",
      }),
    );

    expect(card).toHaveClass("is-expanded");
    expect(
      within(card).getByRole("button", {
        name: "收起发出的会话消息：审查会话",
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(within(card).getByText("主控会话")).toBeInTheDocument();
    expect(within(card).getByText("负责人")).toBeInTheDocument();
    expect(within(card).getByText("#source-1")).toBeInTheDocument();
    expect(within(card).getByText("审查员")).toBeInTheDocument();
    expect(within(card).getByText("#target-8")).toBeInTheDocument();
    expect(within(card).getByText("请检查会话恢复路径。")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-card-id='card-1']")).toHaveLength(1);
  });

  it("renders incoming direction and falls back for an unnamed endpoint", () => {
    render(
      <SessionMessageCard
        card={{
          ...outgoingCard,
          direction: "incoming",
          from: { ...outgoingCard.from, title: undefined },
          state: "delivered",
        }}
      />,
    );

    expect(screen.getByRole("article", { name: "收到的会话消息" })).toHaveClass("direction-incoming");
    expect(screen.getByText("收到")).toBeInTheDocument();
    expect(screen.getByText("来自 未命名会话")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "消息状态：已送达" })).toBeInTheDocument();
  });

  it("updates one collapsed card in place without forcing its result open", () => {
    const { container, rerender } = render(<SessionMessageCard card={outgoingCard} />);

    rerender(
      <SessionMessageCard
        card={{
          ...outgoingCard,
          state: "completed",
          result: "恢复测试全部通过。",
          updatedAt: "2026-07-19T08:03:00.000Z",
        }}
      />,
    );

    expect(container.querySelectorAll("[data-card-id='card-1']")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "消息状态：已完成" })).toBeInTheDocument();
    expect(screen.queryByText("恢复测试全部通过。")).not.toBeInTheDocument();
    expect(screen.queryByText("结果")).not.toBeInTheDocument();
    expect(screen.queryByText("已排队")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "展开发出的会话消息：审查会话",
      }),
    );

    expect(screen.getByText("恢复测试全部通过。")).toBeInTheDocument();
    expect(screen.getByText("结果")).toBeInTheDocument();
  });

  it("opens the peer session only while that conversation still exists", () => {
    const openConversation = vi.fn();
    const { rerender } = render(
      <SessionMessageCard
        card={outgoingCard}
        onOpenConversation={openConversation}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "展开发出的会话消息：审查会话",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开会话" }));
    expect(openConversation).toHaveBeenCalledWith(
      outgoingCard.to.conversationId,
    );

    rerender(
      <SessionMessageCard
        card={{
          ...outgoingCard,
          state: "completed",
          peerExists: false,
        }}
        onOpenConversation={openConversation}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "打开会话" }),
    ).not.toBeInTheDocument();
  });

  it("opens the sender from an incoming card", () => {
    const openConversation = vi.fn();
    render(
      <SessionMessageCard
        card={{ ...outgoingCard, direction: "incoming" }}
        onOpenConversation={openConversation}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "展开收到的会话消息：主控会话",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "打开会话" }));
    expect(openConversation).toHaveBeenCalledWith(
      outgoingCard.from.conversationId,
    );
  });

  it.each([
    ["sending", "发送中"],
    ["running", "处理中"],
    ["waiting", "等待中"],
    ["failed", "失败"],
    ["aborted", "已终止"],
  ] as const)("labels the %s state as %s", (state, label) => {
    render(<SessionMessageCard card={{ ...outgoingCard, state }} />);
    expect(screen.getByRole("status", { name: `消息状态：${label}` })).toBeInTheDocument();
  });
});
