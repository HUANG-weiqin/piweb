// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthDialog } from "./AuthDialog";

afterEach(cleanup);

describe("AuthDialog", () => {
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
