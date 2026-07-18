// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
