# Mobile viewport (390×844) — light spot-check, not a full re-drive

Given the budget already spent on the desktop matrix (11 rows, several
multi-restart investigations), this is a targeted visual/functional check
at the mobile-sized viewport, not a second full pass of every case —
flagging that scope reduction honestly rather than silently skipping it
or overclaiming full coverage.

**Checked:** chat renders correctly at 390×844 (Grace's session, carried
over from `multi-user-isolation`) — message bubbles, composer, and the
suggestion-chip row all lay out without horizontal page overflow. One
cosmetic note: the suggestion-chip row ("Good night routine" / "Who was
at the door at 3pm?" / "Lower the kitchen lights 30%") runs wider than
the viewport and the last chip is visually truncated at the edge — looks
like an intentional horizontally-scrollable row (matches the desktop
layout's chip row shape), not a broken one, but not scrolled/tapped to
confirm. Screenshot: `mobile-390x844.png`.

**Not covered here** (would need a second full pass): permission-confirm
dialog layout at 390px, delegation-progress tiles, the reload-convergence
/ compaction-continue rows at mobile width. Flagging for Task 10 or a
follow-up mobile-focused web pass rather than claiming coverage that
wasn't actually driven.
