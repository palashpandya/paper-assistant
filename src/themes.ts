import { load, save } from './layout';

/** Colour themes. The colours themselves live in themes.css, keyed by data-theme on <html>. */
export const THEMES = [
  { id: 'paper', label: 'Paper (light)' },
  { id: 'solarized-light', label: 'Solarized Light' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'nord', label: 'Nord' },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const savedTheme = (): ThemeId => {
  const id = load<string>('theme', 'paper');
  return THEMES.some((t) => t.id === id) ? (id as ThemeId) : 'paper';
};

export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
  save('theme', id);
}
