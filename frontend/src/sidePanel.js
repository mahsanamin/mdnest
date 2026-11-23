// Pure rules for the right-edge side panel (Chat, Stickies and Pages; Pages
// only with HTML pages on): how wide it may be, and whether a chat can dock at
// all. The panel keeps ONE width whichever of the three it shows, so switching
// with the toolbar buttons never makes it jump. No React here, so the numbers
// are unit-tested on their own (__tests__/sidePanel.test.js).

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

// Whether the Pages list can dock: the editor keeps its minimum width next to
// the narrowest stickies-sized panel. Otherwise the toolbar's Pages button
// opens the full Pages view instead. Phones never dock (checked by the caller).
export function canDockPages(viewport, sidebar) {
  return room(viewport, sidebar) >= STICKIES_PANEL_MIN;
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

// The range for the view showing. Every view shares one remembered width and
// one maximum (as wide as a chat may get, if the window has room), so a width
// picked on one view carries to the others. Only the minimum differs: Stickies
// and Pages can be as narrow as a sticky strip, a chat needs CHAT_PANEL_MIN.
export function sidePanelBounds(viewport, sidebar, view) {
  if (view === 'chat') return chatPanelBounds(viewport, sidebar);
  const max = Math.min(CHAT_PANEL_MAX, room(viewport, sidebar));
  return { min: STICKIES_PANEL_MIN, max: Math.max(STICKIES_PANEL_MIN, max) };
}

// The panel's width for the view showing: the remembered one (null when never
// resized) or the default, clamped to that view's range. The remembered value
// is not changed by the clamp, so a panel narrowed below a chat's minimum
// widens for a chat and goes back to the chosen width for Stickies or Pages.
export function sidePanelWidth(saved, viewport, sidebar, view) {
  return clampWidth(saved ?? defaultChatPanelWidth(viewport), sidePanelBounds(viewport, sidebar, view));
}

export function clampWidth(width, { min, max }) {
  return Math.min(max, Math.max(min, width));
}
