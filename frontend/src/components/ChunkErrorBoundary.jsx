import { Component } from 'react';

// Keeps a failed code-split chunk from taking the whole app down.
//
// React unmounts the entire tree when a render-time error reaches the root, so
// a lazily-imported editor that fails to download leaves a blank page with no
// sidebar, no toolbar and no way back — the user cannot even open a different
// note. The Live editor has been guarded by EditorErrorBoundary for this exact
// reason; this boundary covers the other lazy surfaces (drawings, task board,
// slides), which had only a <Suspense> around them. Suspense handles the
// *pending* state of an import, never a *rejected* one.
//
// lazyWithRetry already retries a failed import (including a cache-busting
// attempt for a proxy that cached an error for an immutable asset URL), so by
// the time this renders, loading has genuinely failed. The remaining job is to
// say so, keep the rest of the app usable, and offer a reload — React.lazy
// caches the rejected promise, so a fresh document is the only reliable retry.
class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error(`${this.props.label || 'Component'} failed to load:`, error, info);
  }
  componentDidUpdate(prevProps) {
    // Navigating to another note clears the failure, so one bad load doesn't
    // poison the surface for the rest of the session.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      const label = this.props.label || 'this view';
      return (
        <div className="chunk-error">
          <h3>Couldn&rsquo;t load {label}</h3>
          <p>
            The code for {label} failed to download. This is usually a network
            blip or a stale cache between you and the server — your note is
            untouched.
          </p>
          <div className="chunk-error-actions">
            <button onClick={() => window.location.reload()}>Reload page</button>
            {this.props.onDismiss && (
              <button className="secondary" onClick={this.props.onDismiss}>
                {this.props.dismissLabel || 'Go back'}
              </button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ChunkErrorBoundary;
