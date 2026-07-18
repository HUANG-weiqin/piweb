// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionDialog } from "./ExtensionDialog";

const REQUEST_A = "a81ab25f-041e-4559-b890-04c0eeb476e4";
const REQUEST_B = "668034c9-2181-4ea5-bbb0-6a5ef8cc9ff1";

afterEach(cleanup);

describe("ExtensionDialog", () => {
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
