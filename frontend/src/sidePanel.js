// Pure rules for the right-edge side panel (Chat, Stickies and Pages tabs; the
// Pages tab only with HTML pages on): how wide each tab may be, and whether a
// chat can dock at all. The Pages tab is a narrow list like the stickies, so it
// takes the stickies bounds and shares their remembered width. No React here, so the
// numbers are unit-tested on their own (__tests__/sidePanel.test.js).

// The narrowest the editor column may get while the panel is open. Below
// this a note is not usable, so the panel stops growing instead.
export const EDITOR_MIN_WIDTH = 400;

// A chat needs more room than a sticky: its header carries several buttons
// and messages read badly in a strip. Under this, chat is not offered in the
// panel and opens full screen instead.
export const CHAT_PANEL_MIN = 520;
export const CHAT_PANEL_MAX = 960;

// The sticky drawer's range from before the panel had tabs, unchanged.
export const STICKIES_PANEL_MIN = 260;
export const STICKIES_PANEL_MAX = 760;

// Room left for the panel once the sidebar and a usable editor are placed.
function room(viewport, sidebar) {
  return viewport - sidebar - EDITOR_MIN_WIDTH;
}

// Whether a chat can dock: only when the editor keeps its minimum width next
// to the narrowest chat panel. Phones never dock (the caller checks that
// separately, at the app's 768px breakpoint).
export function canDockChat(viewport, sidebar) {
  return room(viewport, sidebar) >= CHAT_PANEL_MIN;
}

export function chatPanelBounds(viewport, sidebar) {
  const max = Math.min(CHAT_PANEL_MAX, room(viewport, sidebar));
  return { min: CHAT_PANEL_MIN, max: Math.max(CHAT_PANEL_MIN, max) };
}

export function stickiesPanelBounds(viewport, sidebar) {
  const max = Math.min(STICKIES_PANEL_MAX, room(viewport, sidebar));
  return { min: STICKIES_PANEL_MIN, max: Math.max(STICKIES_PANEL_MIN, max) };
}

// A chat panel nobody has resized yet starts at 40% of the window, capped.
export function defaultChatPanelWidth(viewport) {
  return Math.min(Math.round(viewport * 0.4), CHAT_PANEL_MAX);
}

export function clampWidth(width, { min, max }) {
  return Math.min(max, Math.max(min, width));
}
