/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
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

if (
  import.meta.env.DEV
  && new URLSearchParams(window.location.search).get("fixture") === "workbench"
) {
  void import("./VisualFixture").then(({ VisualFixture }) => render(VisualFixture));
} else {
  render(App);
}
