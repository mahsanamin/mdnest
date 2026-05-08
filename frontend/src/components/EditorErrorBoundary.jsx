import { Component } from 'react';

// Catches render-time exceptions thrown by the Live editor (Milkdown
// + GFM/commonmark + node views). Without this, a parse failure or a
// plugin throwing during `Editor.make()` propagates up to React's
// root and unmounts the whole app — the user sees a blank page until
// they hard-reload.
//
// Behavior on catch:
//  1. Call `onError(err)` so the parent can flip `editorMode` to
//     'basic'. The user keeps their place in the file, just in the
//     plain-textarea editor instead of Milkdown.
//  2. Render nothing for one tick so the unmount is clean; the parent
//     re-renders the Basic editor on the next pass.
//
// `resetKey` (typically `${ns}/${path}`) is the per-file cache-bust:
// when the user navigates to a different note, the boundary clears
// so a future Live-mode session on a different file gets a fresh
// chance to mount. Without this, one bad file would lock the user
// into Basic for the rest of the session.
class EditorErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('Live editor crashed:', error, info);
    if (this.props.onError) {
      // Defer to next tick so React can finish its current commit
      // before we ask the parent to re-render with editorMode='basic'.
      setTimeout(() => this.props.onError(error), 0);
    }
  }
  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      // Parent will swap to Basic editor on the next render via onError.
      // Render nothing here so we don't paint a flash of error UI.
      return null;
    }
    return this.props.children;
  }
}

export default EditorErrorBoundary;
