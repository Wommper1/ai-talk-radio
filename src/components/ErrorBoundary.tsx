/**
 * The last line of defence in the browser.
 *
 * A render error anywhere in React unmounts the whole tree, and what the user
 * sees is a blank page — no message, no clue which control caused it, and a
 * show that is very often still running perfectly well on the server behind
 * it. That is indistinguishable from "the app crashed", and it is impossible
 * to report usefully.
 *
 * So the tree gets a boundary. The error is caught, the exact message and the
 * component stack are put on screen where they can be copied, and the running
 * show is left alone.
 */

import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ error, stack: info.componentStack ?? "" });
    // Also to the console, so it survives a reload of this panel.
    console.error("Render error:", error, info.componentStack);
  }

  render(): React.ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    const report = `${error.name}: ${error.message}\n${stack.trim()}`;

    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="font-serif text-2xl text-[#e8e8ee]">The screen fell over.</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--color-mute)]">
          Something in the interface threw while drawing. If a show was on air it is very likely still
          running on the server and still being recorded — it will be in the Library when it finishes.
          Reloading the page is safe.
        </p>

        <pre className="mt-5 max-h-80 overflow-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3.5 font-mono text-xs leading-relaxed text-[var(--color-live)]">
          {report}
        </pre>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(report).catch(() => {})}
            className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs text-[var(--color-dim)] transition-colors hover:border-[var(--color-line-bright)] hover:text-white"
          >
            Copy the error
          </button>
          <button
            type="button"
            onClick={() => this.setState({ error: null, stack: "" })}
            className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs text-[var(--color-dim)] transition-colors hover:border-[var(--color-line-bright)] hover:text-white"
          >
            Try drawing it again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-[var(--color-amber)] px-3 py-2 text-xs text-[var(--color-amber)] transition-colors hover:bg-[var(--color-amber)] hover:text-black"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
