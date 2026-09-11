import type { ComponentChildren, JSX } from "preact";

export interface AppShellProps {
  topbar: ComponentChildren;
  main: ComponentChildren;
  dock?: ComponentChildren;
  /** Fresh login only; runs concurrently with the authenticated shell mount. */
  arriving?: boolean;
}

export function AppShell({ topbar, main, dock, arriving = false }: AppShellProps): JSX.Element {
  return (
    <div class="app-shell" data-app-shell data-login-arrival={arriving || undefined}>
      <header class="app-shell__topbar">{topbar}</header>
      <main class="app-shell__main">{main}</main>
      {dock && <footer class="app-shell__dock">{dock}</footer>}
    </div>
  );
}
