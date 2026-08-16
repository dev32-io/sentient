# Task Acceptance: Make settings Back follow the actual page stack

## Deliverables

- Every settings Back action returns to the immediately previous visible page, including clone editor → filtered Fish results → Voice → Settings → Chat, with route-scoped state preserved.

## Acceptance

- Fish clone editor Back returns to the same filtered and scrolled Fish results page
- The next Back returns to Voice, then Settings, then Chat in actual history order
- Top-bar Back, Android system Back, and iOS native swipe/back are behaviorally equivalent
- No nested page routes directly to a guessed parent or resets the full settings path
- Other touched nested settings pages obey the same invariant
- Fresh-chat host behavior and authenticated session lifetime remain intact

## Boundary Proof

- Android and iOS route-stack tests pin exact push/pop sequences and state retention
- Updated unattended settings/Fish flows expose the restored state and route order for E2E-008 and E2E-009
