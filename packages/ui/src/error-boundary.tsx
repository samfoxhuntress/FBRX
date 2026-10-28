import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './components';

/**
 * What shows instead of a page that failed to draw: what went wrong, a way to try the page again and a reload. Without
 * it, an error while drawing takes the whole window down to an empty background. `resetKey` (the page's route) starts
 * it over when someone goes elsewhere.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A page failed to draw', error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fx-empty" role="alert">
        <h3>This page ran into a problem</h3>
        <p className="fx-secondary">Nothing was lost: try the page again, or reload. If it keeps happening, send FBRX what it says below.</p>
        <pre className="fx-error-detail">{error.message || String(error)}</pre>
        <div className="fx-actions" style={{ justifyContent: 'center' }}>
          <Button variant="primary" icon="refresh" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </div>
    );
  }
}
