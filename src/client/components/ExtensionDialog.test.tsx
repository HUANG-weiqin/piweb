// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../../shared/protocol";
import { ExtensionDialog } from "./ExtensionDialog";

const REQUEST_A = "a81ab25f-041e-4559-b890-04c0eeb476e4";
const REQUEST_B = "668034c9-2181-4ea5-bbb0-6a5ef8cc9ff1";

afterEach(cleanup);

function ExtensionFocusOwnerFixture({
  request,
  onRespond,
}: {
  request: Extract<ExtensionUIRequest, { kind: "input" | "editor" }>;
  onRespond(requestId: string, response: ExtensionUIResponse): void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开扩展输入</button>
    <ExtensionDialog
      pending={open ? { requestId: REQUEST_A, request } : undefined}
      pendingCount={open ? 1 : 0}
      online
      onRespond={(requestId, response) => {
        onRespond(requestId, response);
        setOpen(false);
        return true;
      }}
    />
  </>;
}

describe("ExtensionDialog", () => {
  it.each([
    ["input", { kind: "input", title: "Input value", placeholder: "optional" }, "INPUT"],
    ["editor", { kind: "editor", title: "Editor value", prefill: "seed" }, "TEXTAREA"],
  ] as const)(
    "restores the exact launcher after cancelling an %s request",
    async (_kind, request, expectedTag) => {
      const onRespond = vi.fn();
      render(<ExtensionFocusOwnerFixture request={request} onRespond={onRespond} />);

      const launcher = screen.getByRole("button", { name: "打开扩展输入" });
      expect(launcher.isConnected).toBe(true);
      launcher.focus();
      expect(launcher).toHaveFocus();
      fireEvent.click(launcher);

      const input = screen.getByRole("textbox", { name: request.title });
      expect(input.tagName).toBe(expectedTag);
      expect(input).toHaveAttribute("data-modal-autofocus");
      await waitFor(() => expect(input).toHaveFocus());

      const cancel = screen.getByRole("button", { name: "取消" });
      cancel.focus();
      fireEvent.click(cancel);

      expect(onRespond).toHaveBeenCalledWith(REQUEST_A, { kind: "cancel" });
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: request.title }))
          .not.toBeInTheDocument();
        expect(launcher.isConnected).toBe(true);
        expect(launcher).toHaveFocus();
      });
    },
  );
  it("returns an explicit negative confirmation only once", () => {
    const onRespond = vi.fn(() => true);
    render(<ExtensionDialog
      pending={{
        requestId: REQUEST_A,
        request: { kind: "confirm", title: "Deploy?", message: "Continue?" },
      }}
      pendingCount={1}
      online
      onRespond={onRespond}
    />);

    fireEvent.click(screen.getByRole("button", { name: "否" }));
    fireEvent.click(screen.getByRole("button", { name: "是" }));

    expect(onRespond).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith(
      REQUEST_A,
      { kind: "confirm", confirmed: false },
    );
    expect(screen.getByRole("dialog", { name: "Deploy?" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("等待扩展确认");
  });

  it("resets editable state for the next correlated request", () => {
    const onRespond = vi.fn(() => true);
    const { rerender } = render(<ExtensionDialog
      pending={{
        requestId: REQUEST_A,
        request: { kind: "editor", title: "Draft", prefill: "seed" },
      }}
      pendingCount={2}
      online
      onRespond={onRespond}
    />);

    const editor = screen.getByRole("textbox", { name: "Draft" });
    expect(editor).toHaveValue("seed");
    fireEvent.change(editor, { target: { value: "edited" } });
    rerender(<ExtensionDialog
      pending={{
        requestId: REQUEST_A,
        request: { kind: "editor", title: "Draft", prefill: "seed" },
      }}
      pendingCount={2}
      online
      visible={false}
      onRespond={onRespond}
    />);
    expect(screen.queryByRole("dialog", { name: "Draft" })).not.toBeInTheDocument();
    rerender(<ExtensionDialog
      pending={{
        requestId: REQUEST_A,
        request: { kind: "editor", title: "Draft", prefill: "seed" },
      }}
      pendingCount={2}
      online
      onRespond={onRespond}
    />);
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("edited");
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(onRespond).toHaveBeenLastCalledWith(
      REQUEST_A,
      { kind: "editor", value: "edited" },
    );

    rerender(<ExtensionDialog
      pending={{
        requestId: REQUEST_B,
        request: { kind: "input", title: "Name", placeholder: "optional" },
      }}
      pendingCount={1}
      online
      onRespond={onRespond}
    />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  });
});
