import type { ComponentChildren, JSX } from "preact";

export interface AppShellProps {
  topbar: ComponentChildren;
  main: ComponentChildren;
  dock?: ComponentChildren;
}

export function AppShell({ topbar, main, dock }: AppShellProps): JSX.Element {
  return (
    <div class="app-shell" data-app-shell>
      <header class="app-shell__topbar">{topbar}</header>
      <main class="app-shell__main">{main}</main>
      {dock && <footer class="app-shell__dock">{dock}</footer>}
    </div>
  );
}
