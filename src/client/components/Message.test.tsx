// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../chat/reducer";
import { Message } from "./Message";

afterEach(() => {
  cleanup();
});

describe("Message", () => {
  const toolsMessage: ChatMessage = {
    id: "1",
    role: "assistant",
    text: "",
    thinking: "",
    tools: [
      {
        id: "1",
        name: "read",
        args: { path: "src/index.ts" },
        result: { ok: true },
        status: "done",
      },
    ],
  };

  const manyToolsMessage: ChatMessage = {
    id: "2",
    role: "assistant",
    text: "",
    thinking: "",
    tools: [
      { id: "1", name: "read", args: { path: "old-1.md" }, result: { ok: true }, status: "done" },
      { id: "2", name: "bash", args: { cmd: "old-2" }, result: { ok: true }, status: "done" },
      { id: "3", name: "edit", args: { file: "old-3" }, result: { ok: true }, status: "done" },
      { id: "4", name: "read", args: { path: "old-4" }, result: { ok: true }, status: "done" },
      { id: "5", name: "bash", args: { cmd: "new-1" }, result: { ok: true }, status: "done" },
      { id: "6", name: "edit", args: { file: "new-2" }, result: { ok: true }, status: "done" },
    ],
  };

  it("keeps tool details collapsed by default", () => {
    const { container } = render(<Message message={toolsMessage} />);
    const details = container.querySelector("details.tools") as HTMLDetailsElement;

    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(screen.getByText("工具调用（1）")).toBeInTheDocument();
  });

  it("expands tool details when user clicks the tools summary", () => {
    render(<Message message={toolsMessage} />);

    const summary = screen.getByText("工具调用（1）") as HTMLElement;
    fireEvent.click(summary);
    const details = screen.getByText("工具调用（1）").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getByText(/\"path\"/)).toBeInTheDocument();
    expect(screen.getByText(/\"ok\": true/)).toBeInTheDocument();
  });

  it("collapses long tool lists and can expand to show all calls", () => {
    render(<Message message={manyToolsMessage} />);

    expect(screen.getByText("工具调用（6）")).toBeInTheDocument();
    expect(screen.getByText("已折叠 2 条更早工具调用")).toBeInTheDocument();
    expect(screen.queryByText(/old-1\.md/)).not.toBeInTheDocument();
    expect(screen.getByText("展开全部 6 条")).toBeInTheDocument();
    expect(screen.getByText(/new-2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全部 6 条" }));

    expect(screen.getByRole("button", { name: "收起到最近 4 条" })).toBeInTheDocument();
    expect(screen.getByText(/old-1\.md/)).toBeInTheDocument();
  });
});
