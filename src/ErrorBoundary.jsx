import { Component } from 'react';

/**
 * Last line of defence for the renderer. Without it a single throw inside the
 * 974-line dashboard unmounts the whole tree and leaves a black window with no
 * hint of what broke — the deck would silently stop reporting tunnel state.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('renderer crashed', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-screen place-items-center px-6">
        <div className="w-full max-w-[560px] rounded-[6px] border border-fault/40 bg-fault/[0.06] p-5">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-fault">
            Renderer crashed
          </p>
          <p className="mt-2 text-sm text-ink-2">
            The tunnel may still be running — this is a UI fault, not a network state.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-[4px] border border-line/80 bg-void/60 p-3 font-mono text-[10px] leading-relaxed text-ink-3">
            {String(error?.stack || error?.message || error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-[5px] border border-line bg-white/[0.03] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-ink transition-colors hover:border-blue/40 hover:text-ink-strong"
          >
            Reload UI
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
