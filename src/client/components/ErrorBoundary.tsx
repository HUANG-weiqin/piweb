import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error?: Error;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;

    return <main className="setup-shell">
      <section className="setup-card" role="alert">
        <div className="logo">π</div>
        <h1>页面出错了</h1>
        <p>前端运行时异常，已阻止空白屏。请重新加载页面；如果仍然出现，把下面的信息发给开发者。</p>
        <pre>{this.state.error.message}</pre>
        <button onClick={() => location.reload()}>重新加载</button>
      </section>
    </main>;
  }
}
