// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { startTransition, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLatestCallback } from "./use-latest-callback";

afterEach(cleanup);

describe("useLatestCallback", () => {
  it("publishes only committed closures when a concurrent render is abandoned", () => {
    const called = vi.fn();
    const rendered = vi.fn();
    const suspended = new Promise<never>(() => undefined);

    function Harness({ value, suspend }: { value: string; suspend: boolean }) {
      const callback = useLatestCallback(() => called(value));
      rendered(value);
      if (suspend) throw suspended;
      return <button type="button" onClick={callback}>invoke committed</button>;
    }

    const view = render(
      <Suspense fallback={<div>suspended</div>}>
        <Harness value="committed" suspend={false} />
      </Suspense>,
    );
    act(() => {
      startTransition(() => {
        view.rerender(
          <Suspense fallback={<div>suspended</div>}>
            <Harness value="abandoned" suspend />
          </Suspense>,
        );
      });
    });

    expect(rendered).toHaveBeenCalledWith("abandoned");
    expect(screen.queryByText("suspended")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "invoke committed" }));
    expect(called).toHaveBeenLastCalledWith("committed");
  });

  it("keeps one function identity while invoking the latest closure", () => {
    const called = vi.fn();
    const observed: Array<(suffix: string) => string> = [];

    function Harness({ prefix }: { prefix: string }) {
      const callback = useLatestCallback((suffix: string) => {
        const value = `${prefix}:${suffix}`;
        called(value);
        return value;
      });
      observed.push(callback);
      return <button type="button" onClick={() => callback("value")}>
        invoke
      </button>;
    }

    const { rerender } = render(<Harness prefix="first" />);
    const firstCallback = observed.at(-1)!;
    fireEvent.click(screen.getByRole("button", { name: "invoke" }));
    expect(called).toHaveBeenLastCalledWith("first:value");

    rerender(<Harness prefix="latest" />);
    expect(observed.at(-1)).toBe(firstCallback);
    fireEvent.click(screen.getByRole("button", { name: "invoke" }));
    expect(called).toHaveBeenLastCalledWith("latest:value");
  });
});
