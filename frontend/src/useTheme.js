import { useEffect, useState } from 'react';
import { currentTheme, onThemeChange } from './theme.js';

/**
 * The theme currently painted, re-rendering the caller when it changes.
 *
 * For components whose output is imperative rather than declarative — SVG
 * written into a container, a canvas owned by a third-party editor. React will
 * not redraw those on its own when the theme flips, so they need a value in
 * their dependency array that actually changes.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => currentTheme());
  useEffect(() => onThemeChange(setTheme), []);
  return theme;
}
