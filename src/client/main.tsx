/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, isThemeId } from "./lib/theme-registry";
import "katex/dist/katex.min.css";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

function render(Root: typeof App) {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <Root />
      </ErrorBoundary>
    </StrictMode>,
  );
}

const fixtureParams = import.meta.env.DEV
  ? new URLSearchParams(window.location.search)
  : null;
const fixture = fixtureParams?.get("fixture") ?? null;
// Fixtures render without App, so a DEV-only `theme` param projects the theme directly.
const fixtureTheme = fixture ? fixtureParams?.get("theme") : null;
if (isThemeId(fixtureTheme)) applyTheme(document.documentElement, fixtureTheme);

if (fixture === "workbench") {
  void import("./VisualFixture").then(({ VisualFixture }) => render(VisualFixture));
} else if (fixture === "secondary") {
  void import("./SecondarySurfaceFixture").then(({ SecondarySurfaceFixture }) => {
    root.render(
      <ErrorBoundary>
        <SecondarySurfaceFixture />
      </ErrorBoundary>,
    );
  });
} else {
  render(App);
}
