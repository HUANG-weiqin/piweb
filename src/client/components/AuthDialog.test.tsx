// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthDialog } from "./AuthDialog";

afterEach(cleanup);

function AuthFocusOwnerFixture({ kind }: { kind: "prompt" | "manual" }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>打开认证提示</button>
    {open && <AuthDialog
      requestId={`${kind}-request`}
      request={{ kind, message: `${kind} value` }}
      onRespond={() => undefined}
      onCancel={() => setOpen(false)}
    />}
  </>;
}

describe("AuthDialog", () => {
  it.each(["prompt", "manual"] as const)(
    "restores the exact launcher after cancelling a %s input request",
    async (kind) => {
      render(<AuthFocusOwnerFixture kind={kind} />);

      const launcher = screen.getByRole("button", { name: "打开认证提示" });
      expect(launcher.isConnected).toBe(true);
      launcher.focus();
      expect(launcher).toHaveFocus();
      fireEvent.click(launcher);

      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("data-modal-autofocus");
      await waitFor(() => expect(input).toHaveFocus());

      const cancel = screen.getByRole("button", { name: "取消登录" });
      cancel.focus();
      fireEvent.click(cancel);

      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "登录订阅账户" }))
          .not.toBeInTheDocument();
        expect(launcher.isConnected).toBe(true);
        expect(launcher).toHaveFocus();
      });
    },
  );
  it("preserves the current response while a higher-priority modal is visible", () => {
    const props = {
      requestId: "request-1",
      request: {
        kind: "prompt" as const,
        message: "Verification code",
      },
      onRespond: () => undefined,
      onCancel: () => undefined,
    };
    const view = render(<AuthDialog {...props} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "123456" } });

    view.rerender(<AuthDialog {...props} visible={false} />);
    expect(screen.queryByRole("dialog", { name: "登录订阅账户" })).not.toBeInTheDocument();

    view.rerender(<AuthDialog {...props} />);
    expect(screen.getByRole("textbox")).toHaveValue("123456");
  });

  it("renders secret prompts as password inputs", () => {
    const onRespond = vi.fn();
    render(<AuthDialog
      requestId="secret-request"
      request={{ kind: "prompt", message: "API key", secret: true }}
      onRespond={onRespond}
      onCancel={() => undefined}
    />);

    const input = document.querySelector("input");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input!, { target: { value: "super-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onRespond).toHaveBeenCalledWith("secret-request", { value: "super-secret" });
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("type", "password");
  });
});
