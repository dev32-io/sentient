import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

export interface AppShellProps {
  topbar: ComponentChildren;
  main: ComponentChildren;
  dock?: ComponentChildren;
  /** Fresh login only; runs concurrently with the authenticated shell mount. */
  arriving?: boolean;
}

export function AppShell({ topbar, main, dock, arriving = false }: AppShellProps): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const dockElement = dockRef.current;
    if (!shell || !dockElement) return;
    const measure = () => shell.style.setProperty("--chat-bottom-clear", `${dockElement.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(dockElement);
    return () => observer.disconnect();
  }, [dock]);

  return (
    <div ref={shellRef} class="app-shell" data-app-shell data-login-arrival={arriving || undefined}>
      <header class="app-shell__topbar">{topbar}</header>
      <main class="app-shell__main">{main}</main>
      {dock && <footer ref={dockRef} class="app-shell__dock">{dock}</footer>}
    </div>
  );
}
