export interface ShellResponsiveEvidence {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly documentScrollWidth: number;
  readonly noHorizontalOverflow: boolean;
  readonly textScale: number;
  readonly interactiveTargetCount: number;
  readonly minimumInteractiveTarget: { readonly width: number; readonly height: number } | null;
}

/** Observational fixture hook for desktop, narrow, keyboard, and 200% zoom checks. */
export function measureShellResponsiveEvidence(document: Document): ShellResponsiveEvidence {
  const view = document.defaultView;
  const root = document.documentElement;
  const viewport = { width: view?.innerWidth ?? root.clientWidth, height: view?.innerHeight ?? root.clientHeight };
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-app-shell] button:not([disabled]), [data-history-drawer] button:not([disabled]), [data-history-drawer] input:not([disabled])",
    ),
  )
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => element.getBoundingClientRect());
  const minimumInteractiveTarget =
    targets.length === 0
      ? null
      : {
          width: Math.min(...targets.map((target) => target.width)),
          height: Math.min(...targets.map((target) => target.height)),
        };
  const rootFontSize = Number.parseFloat(view?.getComputedStyle(root).fontSize ?? "16") || 16;
  return {
    viewport,
    documentScrollWidth: root.scrollWidth,
    noHorizontalOverflow: root.scrollWidth <= viewport.width,
    textScale: rootFontSize / 16,
    interactiveTargetCount: targets.length,
    minimumInteractiveTarget,
  };
}
