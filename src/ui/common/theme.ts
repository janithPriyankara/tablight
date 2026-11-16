import type { Settings } from '../../shared/types';
/** Applies the theme setting: 'light'/'dark' force it via <html data-theme>, 'system' follows the OS. */
export function applyTheme(theme: Settings['theme'] | undefined, root: HTMLElement = document.documentElement): void {
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
