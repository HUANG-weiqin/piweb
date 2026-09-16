/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
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

const fixture = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get("fixture")
  : null;

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
