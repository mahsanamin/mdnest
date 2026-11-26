import { describe, it, expect } from 'vitest';
import {
  canDockChat, chatPanelBounds, stickiesPanelBounds, defaultChatPanelWidth, clampWidth,
  sidePanelBounds, sidePanelWidth,
  EDITOR_MIN_WIDTH, CHAT_PANEL_MIN, CHAT_PANEL_MAX, STICKIES_PANEL_MAX,
} from '../sidePanel.js';
import { rememberScroll, recallScroll } from '../chat.js';

const SIDEBAR = 260;

describe('canDockChat', () => {
  it('docks when the editor keeps its minimum next to the narrowest chat panel', () => {
    expect(canDockChat(SIDEBAR + EDITOR_MIN_WIDTH + CHAT_PANEL_MIN, SIDEBAR)).toBe(true);
    expect(canDockChat(SIDEBAR + EDITOR_MIN_WIDTH + CHAT_PANEL_MIN - 1, SIDEBAR)).toBe(false);
  });

  it('does not dock at 1024 with the default sidebar, but does at 1440', () => {
    expect(canDockChat(1024, SIDEBAR)).toBe(false);
    expect(canDockChat(1440, SIDEBAR)).toBe(true);
  });
});

describe('chat panel width', () => {
  it('starts at 40% of the window, capped at the maximum', () => {
    expect(defaultChatPanelWidth(1440)).toBe(576);
    expect(defaultChatPanelWidth(3000)).toBe(CHAT_PANEL_MAX);
  });

  it('never leaves the editor below its minimum', () => {
    const b = chatPanelBounds(1440, SIDEBAR);
    expect(b.min).toBe(CHAT_PANEL_MIN);
    expect(1440 - SIDEBAR - b.max).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
    // A stored width from a wider window is clamped, not kept.
    expect(clampWidth(900, b)).toBe(b.max);
    expect(clampWidth(100, b)).toBe(CHAT_PANEL_MIN);
  });

  it('is capped on a very wide window', () => {
    expect(chatPanelBounds(4000, SIDEBAR).max).toBe(CHAT_PANEL_MAX);
  });
});

describe('stickies panel width', () => {
  it('keeps its old range on a roomy window', () => {
    expect(stickiesPanelBounds(1440, SIDEBAR)).toEqual({ min: 260, max: STICKIES_PANEL_MAX });
  });

  it('shrinks its maximum rather than squeezing the editor, but never below its minimum', () => {
    expect(stickiesPanelBounds(1024, SIDEBAR).max).toBe(1024 - SIDEBAR - EDITOR_MIN_WIDTH);
    expect(stickiesPanelBounds(800, SIDEBAR).max).toBe(260);
  });
});

describe('chat scroll memory', () => {
  it('is kept per chat', () => {
    rememberScroll('ns', 'Chats/a.md', { n: '12', offset: 30 });
    rememberScroll('ns', 'Chats/b.md', { n: null });
    expect(recallScroll('ns', 'Chats/a.md')).toEqual({ n: '12', offset: 30 });
    expect(recallScroll('ns', 'Chats/b.md')).toEqual({ n: null });
    expect(recallScroll('other', 'Chats/a.md')).toBe(null);
  });
});

describe('canDockPages', () => {
  it('docks when the editor keeps its minimum next to the narrowest list', async () => {
    const { canDockPages, EDITOR_MIN_WIDTH, STICKIES_PANEL_MIN } = await import('../sidePanel.js');
    expect(canDockPages(260 + EDITOR_MIN_WIDTH + STICKIES_PANEL_MIN, 260)).toBe(true);
    expect(canDockPages(260 + EDITOR_MIN_WIDTH + STICKIES_PANEL_MIN - 1, 260)).toBe(false);
    expect(canDockPages(1280, 260)).toBe(true);
    expect(canDockPages(800, 260)).toBe(false);
  });
});

describe('one side panel width for every view', () => {
  it('every view shares one maximum; only a chat has a higher minimum', () => {
    expect(sidePanelBounds(1440, SIDEBAR, 'chat')).toEqual(chatPanelBounds(1440, SIDEBAR));
    for (const view of ['stickies', 'pages']) {
      expect(sidePanelBounds(1440, SIDEBAR, view)).toEqual({ min: 260, max: chatPanelBounds(1440, SIDEBAR).max });
    }
    expect(sidePanelBounds(1024, SIDEBAR, 'stickies')).toEqual(stickiesPanelBounds(1024, SIDEBAR));
  });
  it('a width picked on one view carries to the others', () => {
    for (const view of ['chat', 'stickies', 'pages']) {
      expect(sidePanelWidth(null, 1440, SIDEBAR, view)).toBe(defaultChatPanelWidth(1440));
      expect(sidePanelWidth(700, 1440, SIDEBAR, view)).toBe(700);
    }
  });
  it('a panel narrowed below the chat minimum widens only while a chat shows', () => {
    expect(sidePanelWidth(300, 1440, SIDEBAR, 'stickies')).toBe(300);
    expect(sidePanelWidth(300, 1440, SIDEBAR, 'pages')).toBe(300);
    expect(sidePanelWidth(300, 1440, SIDEBAR, 'chat')).toBe(CHAT_PANEL_MIN);
  });
  it('never leaves the editor below its minimum', () => {
    expect(sidePanelWidth(2000, 1024, SIDEBAR, 'stickies')).toBe(1024 - SIDEBAR - EDITOR_MIN_WIDTH);
    expect(sidePanelWidth(2000, 4000, SIDEBAR, 'chat')).toBe(CHAT_PANEL_MAX);
  });
});
