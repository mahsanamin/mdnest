// Shown instead of the cards when the board could not be read.
//
// Instead of, not alongside: the board is saved by PUTting it WHOLE, so any
// card rendered here would be editable, and one keystroke would replace a
// real board on the server with whatever this failed load produced. Showing
// nothing to edit is the guarantee; the check in updateStickies is the
// backstop.
function StickiesLoadError({ onRetry }) {
  return (
    <div className="stickies-empty">
      <p>Couldn&rsquo;t load your stickies.</p>
      <p className="stickies-empty-note">
        Nothing has been changed — your board is still on the server. Editing is
        held until it loads, so a failed read can&rsquo;t overwrite it.
      </p>
      <button className="stickies-retry" onClick={onRetry}>Try again</button>
    </div>
  );
}

export default StickiesLoadError;
