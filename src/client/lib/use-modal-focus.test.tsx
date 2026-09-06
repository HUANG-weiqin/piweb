// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { type ReactNode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useModalFocus } from "./use-modal-focus";

afterEach(cleanup);

function Scope({
  name,
  children,
  preferred = true,
}: {
  name: string;
  children?: ReactNode;
  preferred?: boolean;
}) {
  const ref = useModalFocus<HTMLElement>(true, name);
  return <section ref={ref} data-testid={name} tabIndex={-1}>
    {preferred && <button data-modal-autofocus>{name} preferred</button>}
    {children}
  </section>;
}

describe("useModalFocus restoration", () => {
  it("restores the exact connected enabled launcher", () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && <Scope name="dialog">
          <button onClick={() => setOpen(false)}>Close</button>
        </Scope>}
      </>;
    }

    render(<Fixture />);
    const launcher = screen.getByRole("button", { name: "Open" });
    launcher.focus();
    fireEvent.click(launcher);
    expect(screen.getByRole("button", { name: "dialog preferred" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(launcher).toHaveFocus();
  });

  it("falls back to the parent preferred control when the launcher remains connected but disabled", () => {
    function Fixture() {
      const [childOpen, setChildOpen] = useState(false);
      const [launcherDisabled, setLauncherDisabled] = useState(false);
      return <Scope name="parent">
        <button disabled={launcherDisabled} onClick={() => setChildOpen(true)}>Open child</button>
        {childOpen && <Scope name="child">
          <button onClick={() => setLauncherDisabled(true)}>Disable launcher</button>
          <button onClick={() => setChildOpen(false)}>Close child</button>
        </Scope>}
      </Scope>;
    }

    render(<Fixture />);
    const launcher = screen.getByRole("button", { name: "Open child" });
    launcher.focus();
    fireEvent.click(launcher);
    fireEvent.click(screen.getByRole("button", { name: "Disable launcher" }));
    fireEvent.click(screen.getByRole("button", { name: "Close child" }));

    expect(launcher).toBeDisabled();
    expect(screen.getByRole("button", { name: "parent preferred" })).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it("falls back to the first enabled parent control when the launcher disconnects", () => {
    function Fixture() {
      const [childOpen, setChildOpen] = useState(false);
      const [launcherVisible, setLauncherVisible] = useState(true);
      return <Scope name="parent" preferred={false}>
        <button>Parent first</button>
        {launcherVisible && <button onClick={() => setChildOpen(true)}>Open child</button>}
        {childOpen && <Scope name="child">
          <button onClick={() => setLauncherVisible(false)}>Remove launcher</button>
          <button onClick={() => setChildOpen(false)}>Close child</button>
        </Scope>}
      </Scope>;
    }

    render(<Fixture />);
    const launcher = screen.getByRole("button", { name: "Open child" });
    launcher.focus();
    fireEvent.click(launcher);
    fireEvent.click(screen.getByRole("button", { name: "Remove launcher" }));
    expect(launcher).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close child" }));

    expect(screen.getByRole("button", { name: "Parent first" })).toHaveFocus();
  });

  it("falls back only to the immediate surviving parent scope", () => {
    function Fixture() {
      const [middleOpen, setMiddleOpen] = useState(false);
      const [topOpen, setTopOpen] = useState(false);
      const [topLauncherDisabled, setTopLauncherDisabled] = useState(false);
      return <Scope name="outer">
        <button onClick={() => setMiddleOpen(true)}>Open middle</button>
        {middleOpen && <Scope name="middle" preferred={false}>
          <button disabled={topLauncherDisabled} onClick={() => setTopOpen(true)}>Open top</button>
          {topOpen && <Scope name="top">
            <button onClick={() => setTopLauncherDisabled(true)}>Disable top launcher</button>
            <button onClick={() => setTopOpen(false)}>Close top</button>
          </Scope>}
        </Scope>}
      </Scope>;
    }

    render(<Fixture />);
    const middleLauncher = screen.getByRole("button", { name: "Open middle" });
    middleLauncher.focus();
    fireEvent.click(middleLauncher);
    const topLauncher = screen.getByRole("button", { name: "Open top" });
    topLauncher.focus();
    fireEvent.click(topLauncher);
    fireEvent.click(screen.getByRole("button", { name: "Disable top launcher" }));
    fireEvent.click(screen.getByRole("button", { name: "Close top" }));

    expect(screen.getByTestId("middle")).toHaveFocus();
    expect(screen.getByRole("button", { name: "outer preferred" })).not.toHaveFocus();
  });

  it("skips controls hidden by a panel ancestor when choosing modal focus", () => {
    function Fixture() {
      const ref = useModalFocus<HTMLElement>(true, "dialog");
      return <section ref={ref} tabIndex={-1}>
        <div hidden><button data-modal-autofocus>Hidden preferred</button></div>
        <button data-modal-autofocus>Visible preferred</button>
      </section>;
    }

    render(<Fixture />);

    expect(screen.getByRole("button", { name: "Visible preferred" }))
      .toHaveFocus();
    expect(screen.queryByRole("button", { name: "Hidden preferred" }))
      .not.toBeInTheDocument();
  });

  it("does not focus an arbitrary document control when no parent scope survives", () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      const [launcherDisabled, setLauncherDisabled] = useState(false);
      return <>
        <button disabled={launcherDisabled} onClick={() => setOpen(true)}>Open</button>
        <button data-modal-autofocus>Unrelated</button>
        {open && <Scope name="dialog">
          <button onClick={() => setLauncherDisabled(true)}>Disable launcher</button>
          <button onClick={() => setOpen(false)}>Close</button>
        </Scope>}
      </>;
    }

    render(<Fixture />);
    const launcher = screen.getByRole("button", { name: "Open" });
    launcher.focus();
    fireEvent.click(launcher);
    fireEvent.click(screen.getByRole("button", { name: "Disable launcher" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.getByRole("button", { name: "Unrelated" })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });
});
