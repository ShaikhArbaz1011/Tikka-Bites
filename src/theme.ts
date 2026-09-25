/** Light / dark theme: follows the device by default; the user can force one. */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'restobill.theme';
const BG = { light: '#faf7f5', dark: '#0b0b0b' } as const;
const dark = window.matchMedia('(prefers-color-scheme: dark)');

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolvedTheme(pref: ThemePref = getThemePref()): 'light' | 'dark' {
  return pref === 'system' ? (dark.matches ? 'dark' : 'light') : pref;
}

export function applyTheme(pref: ThemePref = getThemePref()): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = pref;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BG[resolvedTheme(pref)]);
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* private mode: applies for this session only */
  }
  applyTheme(pref);
  document.dispatchEvent(new CustomEvent('themechange'));
}

/** Keep the browser UI colour in sync when the device theme flips. */
dark.addEventListener('change', () => applyTheme());
