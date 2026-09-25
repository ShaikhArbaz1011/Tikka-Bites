/**
 * Resolve a built-in asset path ("/brand/x.webp", "/dishes/y.webp") against the
 * app's base URL, so the app works at a site root (Netlify/Vercel) and in a
 * sub-folder (GitHub Pages: /<repo>/). Data URLs (uploaded photos) pass through.
 */
export function assetUrl(path: string): string {
  return path.startsWith('/') ? `${import.meta.env.BASE_URL}${path.slice(1)}` : path;
}
