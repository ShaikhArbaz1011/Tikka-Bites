/**
 * Resolve a built-in asset path (e.g. "/brand/logo-wide.webp") against the
 * app's base URL, so the app works at a site root (Netlify/Vercel) and in a
 * sub-folder (GitHub Pages: /<repo>/). Data URLs (an uploaded logo) pass through.
 */
export function assetUrl(path: string): string {
  return path.startsWith('/') ? `${import.meta.env.BASE_URL}${path.slice(1)}` : path;
}
