# Mobile viewport (390×844) — SUPERSEDED by the full re-drive

**Read `qa/web/evidence/2026-07-30-mobile-390-matrix/` instead.** This dir was the first pass's
single-screenshot spot-check, which explicitly did not cover the matrix at mobile width. The
matrix has since been driven for real at 390×844 — 7 rows PASS, 3 rows recorded as
viewport-independent with the reasoning, 4 BLOCKED at every viewport — and one real mobile-only
defect (`.app-shell` overflows 390 by 53 px and one header tap shifts the app off-screen
irrecoverably) was found in the process.

Kept only for the two corrections it earned:

1. **Its screenshot was taken in a stale layout.** The check resized an already-loaded page
   without reloading, so the app painted with desktop geometry — which is why the shot showed the
   suggestion-chip row apparently truncated. Resize must always be followed by a reload before
   asserting anything about layout (now written up in `agents/docs/testing-knowledge.md` →
   "Mobile-sized viewport (390×844)").
2. **Its open question is answered.** The chip row is `overflow-x: auto` with
   `scrollWidth 511 > clientWidth 370` — an intentionally scrollable row, not a broken one. Same
   for the tool-pill strip (`scrollWidth 344 > clientWidth 332`).

`mobile-390x844.png` (local only — `*.png` is gitignored repo-wide) is the stale-layout
screenshot: evidence of the driver artifact, not of the product's mobile layout.
