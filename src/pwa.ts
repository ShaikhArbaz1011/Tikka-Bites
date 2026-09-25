import { actionToast } from './ui/components/toast';

/** Register the service worker (production only) and offer updates politely. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
      // Reload only when the user accepted an update, never on the first install
      // (clients.claim() also fires controllerchange, which must not reload mid-bill).
      let accepted = false;
      const offer = (worker: ServiceWorker) =>
        actionToast('A new version is ready.', 'Reload', () => {
          accepted = true;
          worker.postMessage('SKIP_WAITING');
        });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded || !accepted) return;
        reloaded = true;
        location.reload();
      });
    } catch {
      /* offline support unavailable; the app still works online */
    }
  });
}
