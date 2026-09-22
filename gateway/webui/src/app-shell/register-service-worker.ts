export function registerAppShellServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
}
