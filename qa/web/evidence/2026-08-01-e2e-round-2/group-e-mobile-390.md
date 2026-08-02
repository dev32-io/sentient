# Group E — mobile-390 re-check

Driven live via Playwright MCP against the real local dev stack (`http://localhost:5173`
webui, gateway on `:8888`, real docker MCP addons, real native whisper-stt/local-tts).
Pre-flight: `bun qa/web/stack-integrity.ts` → `RESULT PASS — pass=9 fail=0 skip-optional=0
of 9 declared` (run at 16:50:27, before driving).

Browser was resized to **390×844** for the entire row and back to **1280×900** at the end.
Already authenticated as **Ada** (`u_0417d3b0`) from a prior group's run in this same
browser profile (localStorage/session persisted) — verified live via the DOM (`button "Ada"`
in the header) rather than re-driving the login flow, since Group A already owns login E2E
at this viewport-independent flow. This row is scoped to layout/behavior of already-logged-in
screens at 390×844, per dispatch.

Raw log excerpt: `group-e-log-excerpt.txt` (same directory). Screenshots: `screenshots-group-e/`.

**Standing oracle used on every screen below:** `document.documentElement.scrollWidth <=
window.innerWidth` (no page-level horizontal scroll) — checked via `browser_evaluate`, not by
eye. Where noted, this oracle is **not sufficient on its own** (see ROW 2) — clipped content
inside an `overflow:hidden` ancestor never shows up in `document.scrollWidth`, so I also
walked the DOM ancestor chain and compared each element's own box to its parent.

---

## ROW 1 — chat feed (`mobile-390-recheck`, check 1) — **PASS**

**Oracle stated up front:** no page-level horizontal overflow; message bubbles fit within the
390px viewport with visible margin, not touching the edges.

**Drive:** sent *"At 390px viewport, please confirm you can see this message with the marker
MOBILE-FEED-CHECK-7781, then briefly say hi."* Got a reply echoing the marker.

**Measured** (`browser_evaluate` on the last two `<article>` bubbles):
```
documentScrollWidth: 390, innerWidth: 390  → no overflow
user bubble:      x=12, width=366, right=378
assistant bubble: x=12, width=366, right=378
```
Both bubbles sit at 366px width with a consistent 12px margin on both sides of the 390px
viewport — comfortably inside, not edge-to-edge.

**Could this oracle still have failed?** Yes — if bubble `max-width` were a fixed px value
instead of a percentage/viewport-relative one, a single long word could have pushed a bubble
wider than the viewport while `document.scrollWidth` still (misleadingly) read 390 if some
ancestor clipped it. I didn't stop at the page-level check; ROW 2 is exactly this failure mode,
just triggered by a different message.

Screenshot: `screenshots-group-e/row1-chat-feed-basic.png`.

---

## ROW 2 — long structured reply (`mobile-390-recheck`, check 2) — **FAIL** (long-token case)

**Oracle stated up front:** does a long, structured reply wrap, or force sideways scroll? I
deliberately asked for three failure-prone shapes in one message: a numbered list, a markdown
table, and one long **unbroken** token (a URL with no spaces) — the classic case that breaks
naive word-wrap CSS.

**Drive:** *"Give me a numbered list of 10 tips for organizing a home office. Then add a
markdown table comparing 4 types of desk organizers by price, size, and material. Finally, on
its own line, include this long unbroken example URL exactly as written:
`https://example.com/very/long/path/segment/that/should/not/force/horizontal/scroll/abcdefghijklmnopqrstuvwxyz1234567890`"*

**Numbered list: PASS.** Wrapped correctly across multiple lines, no overflow (see screenshot).

**Table: not exercised.** The model answered with plain prose/line-items instead of an actual
markdown `<table>` this trial (`document.querySelector('table')` → `null` in the reply). This
is model-response variance, not something I can pin on the renderer — flagging as **untested**,
not a pass, so a future run should re-ask more forcefully or use a fixed fixture message
instead of a free-form model request when this specific case matters.

**Long unbroken URL: FAIL — silently clipped, not wrapped, not scrolled.**

Page-level oracle first: `document.documentElement.scrollWidth (390) <= innerWidth (390)` —
**true**. On its own this reads as a clean pass. It is not: I walked the DOM ancestor chain
from the rendered `<a>` (the autolinked URL) up to `<main>` and it tells a different story:

```
<a> (the URL text)              width=823.8px  right=880.8px   overflow-wrap: normal
<p>                              width=308px    scrollWidth=824  overflow-x: visible
.bubble-text__md                 width=308px    scrollWidth=824  overflow-x: visible
.bubble-text                     width=308px    scrollWidth=824  overflow-x: visible
.message-bubble__text-inner      width=332px    scrollWidth=836  overflow-x: visible
.message-bubble__text-wrap       width=334px  clientWidth=332  scrollWidth=836  overflow-x: HIDDEN  ← clips here
.message-bubble__body            width=334px    scrollWidth=334  overflow-x: visible
<article>                        width=366px    scrollWidth=366  overflow-x: visible
.message-list / .chat-view__content / .chat-view (390px, overflow-x: hidden)
```

**Root cause:** `.message-bubble__text-wrap` (`gateway/webui/src/styles/components.css:417-428`)
sets `overflow: hidden` on the bubble shell. Nothing in `.bubble-text` / `.bubble-text__md`
(same file, lines 447-496, including the `a` selector at line 493) sets `overflow-wrap` or
`word-break` to force a break on an unbroken token. The browser's default
(`overflow-wrap: normal`, confirmed via computed style) refuses to break a spaceless string, so
it paints 823.8px wide inside a 332px-wide clipping box — the tail (roughly 504 of 836 scroll
px, i.e. more than half the string) is rendered but **invisible**, with no ellipsis and no
scrollbar to signal more content exists. Confirmed visually in the screenshot: the link text
literally stops mid-string at `"...segment/tha"`.

The fix pattern already exists in the same stylesheet — `.tool-inline-detail__preview` (line
585-594, the tool-call arg/result debug panel) correctly sets `overflow-wrap: anywhere` for
exactly this class of problem. It's just never applied to the chat-bubble markdown text.

**Why this is mobile-viewport-relevant, not a "found it anywhere" bug:** `.message-bubble__text-wrap`
has `max-width: 88%`, so the absolute pixel budget for a single token scales with viewport
width. At 390px that budget is ~332px of usable text width; the same 122-character URL would
very plausibly fit inside a much wider desktop bubble without ever triggering the clip. I did
not cross-check desktop in this run (out of scope for this row), but the CSS math makes mobile
strictly more exposed to this defect.

**Could this oracle still have failed to catch something?** The reverse concern applies here —
the page-level oracle (390≤390) is the one that COULD have hidden this without the ancestor
walk. I'm flagging that explicitly: a shallower check ("no page horizontal scroll") would have
been a false PASS for this exact defect.

Screenshot: `screenshots-group-e/row2-long-url-clipped.png`.

---

## ROW 3 — sessions drawer (`mobile-390-recheck`, check 3) — **PASS** (fit/close), pre-existing known defect noted

**Oracle stated up front:** does the drawer fit within the viewport, and does it close
correctly (verified by a real close action + waiting for the state to settle, not just
clicking and assuming)?

**Drive:** opened via the header "Past chats" toggle.

**Fit:** `.drawer__panel` (the actual sliding panel, not the full-viewport `.drawer` wrapper
that also contains the backdrop) measures **340×844** at `x=0`, confirmed against the CSS rule
`width: min(340px, 92vw)` inside `@media (max-width: 620px)` (`drawer.css:557-561`). This
leaves a **50px-wide reachable backdrop strip** at `x:[340,390]`, confirmed via
`document.elementFromPoint(370, y)` → `.drawer__backdrop` for multiple y values top-to-bottom.
Page-level oracle: `documentScrollWidth (390) === innerWidth (390)`, no overflow.

**A dead end I ruled out first:** my first close attempt — re-clicking the SAME header toggle
button reference the drawer was opened from — timed out with Playwright reporting the click
was intercepted by `<h2 class="drawer__heading">`. I initially treated this as a candidate bug
("drawer can't be closed"), but confirmed it is not: the drawer panel is `position: fixed`,
`z-index: 100` vs. the header's `z-index: 10`, so the panel legitimately sits on top of the
header (including the toggle button's screen location) at **every** viewport width, by design
— this is not viewport-specific. The real, intended close paths are the backdrop and Escape
(confirmed by reading `drawer.tsx:39-48,64`), not a second tap on the same spot.

**Close, verified two ways:**
1. `document.querySelector('.drawer__backdrop').click()` (a real dispatched click event, same
   event-handling path a physical tap on the 50px backdrop strip would take) → after a 300ms
   settle, `.drawer.drawer--open` no longer matches and `aria-hidden` flips to `"true"`.
2. Re-opened via the header toggle (confirms the toggle works when the drawer starts closed),
   then pressed **Escape** → same closed-state confirmation.

**Pre-existing, already-filed defect — not new, not scored here:** the drawer shows *"Couldn't
load sessions — try again."* with a Retry button instead of a session list. Network:
`GET /api/v1/sessions?limit=50&offset=0` → `404` (confirmed independently via
`curl -k https://localhost:8888/api/v1/sessions...` → `404`, and by grepping the gateway
source — no `/sessions` REST route is registered anywhere under `gateway/src`). This is
**D15** (`docs/native-todo.md` §1), already driven and documented live by Group A in this same
round (`group-a-auth-and-newchat.md` ROW 3). Consequence for this row: I could not verify
"does a *populated* list of past-chat rows fit/scroll correctly at 390px" — the empty/error
state fits fine (verified above), but the row-list layout itself is untested this round because
there's nothing to list. The `.row-menu__trigger` mobile tap-target rule (44×44, `drawer.css:409-416`)
is confirmed correct **by CSS inspection only**, not by an actual click on an actual row.

Screenshot: `screenshots-group-e/row3-sessions-drawer-open.png`.

---

## ROW 4 — settings (`mobile-390-recheck`, check 4) — **PASS**

**Oracle stated up front:** does the settings nav work at 390px (reachable, not clipped), and
do individual panes render without page-level horizontal overflow?

**Drive:** opened via the header gear icon (accessible name is "Household" — the icon opens a
combined household/settings area). Visited **Memory**, **Model**, and **Account** (three
panes, spanning all three visually-distinct nav groups: content panes, personal panes,
household-admin panes).

**Nav:** at 390px the sidebar collapses to a horizontal tab strip (`.s-nav`), correctly using
**contained** scroll rather than page overflow: `overflow-x: auto`, `scrollWidth: 1347` vs.
`clientWidth: 390` — the strip itself scrolls, `document.documentElement.scrollWidth` stays at
390 throughout. Clicking a tab that starts off-screen (**Model**, 5th of 8) auto-scrolled it
into view and activated correctly (`heading === "Model"` confirmed after click).

**Each pane, measured:**
| Pane | Heading confirmed | `documentScrollWidth` | Notes |
|---|---|---|---|
| Memory | "Memory" | 390 (= innerWidth) | tab strip + edit/preview toggle + textarea all fit |
| Model | "Model" | 390 | current-selection card + scrollable model-browse list fit, no clipping |
| Account | "Account" | 390 | fits |

Nothing clipped or unreachable in any of the three panes.

Screenshots: `screenshots-group-e/row4-settings-memory-pane.png`,
`row4-settings-model-pane.png`, `row4-settings-account-pane.png`.

---

## ROW 5 — permission dialog / delegation (`mobile-390-recheck`, check 5) — **PASS**

**Oracle stated up front:** does the dialog fit the viewport; do Allow/Deny stay reachable
without scrolling the page; does a long `taskPrompt` scroll **inside its own container**
rather than push the buttons off-screen? Checked via DOM/computed-style reads (per the brief:
"a screenshot cannot prove text isn't clipped by CSS"), not eyeballing — screenshots are
included as corroborating evidence, not the primary oracle.

Two trials were run specifically because the first one, while fully passing, was **not a
non-vacuous test of the scroll mechanism** — I flagged that mid-task and pushed a second,
longer trial rather than call it done on a technicality.

### Trial A — 423-char taskPrompt

**Drive:** *"Delegate this to Hermes verbatim... Research the history of the printing
press... End with this exact marker: MOBILE-DELEGATE-TAIL-9915"*

```
dialogRect: w=390 h=594.84 → bottom=844=innerHeight, right=390=innerWidth  (fits exactly)
argRowCount: 2 (agent, taskPrompt — one row per argument)
taskPrompt: length=423, ends with marker, dialog.textContent includes marker → not truncated
argsContainer: scrollHeight=259, clientHeight=259 (equal — did NOT need to scroll)
  maxHeight (computed): 337.6px (= 40vh of the 844px viewport, matches permission-dialog.css:29 `max-height: 40vh`)
Allow: y=727 h=48 bottom=775 right=371 — fully inside viewport
Deny:  y=783 h=48 bottom=831 right=371 — fully inside viewport
pageScrollY=0, documentScrollable=false
```
This passes, but the args box didn't actually overflow at 423 chars, so it doesn't yet prove
the scroll-vs-push-buttons-off-screen behavior — only that the mechanism (`overflow-y: auto`,
capped `max-height`) is present in computed style. **Could this oracle still have failed?** In
this trial specifically, yes — a regression that made the cap not apply at all would look
identical here since nothing forced it to engage. So I ran a second, deliberately longer trial.

**Denied.** Log confirms `permission-broker.settled reason="denied"`,
`tool-broker.pdp.confirm-resolved confirmed=false` for `toolCallId="call_5sn7gl4x"` at
17:03:36 (full lines in `group-e-log-excerpt.txt`).

Screenshot: `screenshots-group-e/row5-permission-dialog-423char.png`.

### Trial B — 996-char taskPrompt (forced overflow)

**Drive:** a second, longer delegation — steam-locomotive history, deliberately padded past
900 characters, tail marker `MOBILE-DELEGATE-LONGARG-TAIL-4471`.

```
dialogRect: w=390 h=673.22 → bottom=844=innerHeight, right=390=innerWidth  (still fits exactly)
taskPrompt: length=996, ends with marker → full value present, not truncated
argsContainer: scrollHeight=511, clientHeight=338  → 511 > 338, GENUINELY OVERFLOWING
  maxHeight (computed): 337.6px, overflow-y: auto  (the cap is doing real work this time)
Allow: y=727 h=48 bottom=775 right=371  ← IDENTICAL position to Trial A
Deny:  y=783 h=48 bottom=831 right=371  ← IDENTICAL position to Trial A
pageScrollY=0, documentScrollable=false
```

This is the non-vacuous proof: the args box genuinely overflows its 337.6px cap (511px of
content in a 338px window) and clips/scrolls **internally**, while the Allow/Deny buttons sit
at the exact same pixel position as Trial A, completely unaffected, still fully inside the
390×844 viewport, with the page itself never becoming scrollable. The screenshot shows this
directly: the taskPrompt text is visibly cut off mid-sentence ("...articulated" at the visible
bottom edge of its own box) while both buttons remain fully visible below it.

**Denied.** Log confirms the same pattern for `toolCallId="call_kqs9axdo"` at 17:05:28. Checked
`hermes-runner.run.start` count across the whole 17:02–17:06 window spanning both trials: **0**
— neither denied delegation actually ran.

Screenshot: `screenshots-group-e/row5-permission-dialog-996char-overflow.png`.

---

## Tap-target sweep (stated oracle: primary controls ≥ ~44px)

Measured via `getBoundingClientRect()` on the actual interactive element (not a padded parent):

| Control | Size | Verdict vs. ~44px oracle |
|---|---|---|
| Header "Past chats" toggle | 44×44 | PASS |
| Drawer "New chat" button | 315×50 | PASS |
| Drawer row-menu trigger (mobile CSS rule, not clicked live — see ROW 3 caveat) | 44×44 | PASS (by CSS only) |
| Composer **hold-to-talk mic switch** (`role="switch"`, the app's primary voice-input control) | **32×32** | **FAIL** |
| Composer mute button | **32×32** | **FAIL** |
| Composer send button | **28×28** | **FAIL** |

**Root cause for the three FAILs:** `.mic-corner` is already only 34×34 at the desktop
default (`components.css:814-820`) — below 44px even before any mobile override — and the
`@media (max-width: 620px)` block shrinks it further to 32×32
(`components.css:1246-1247`), alongside `.composer__bottom-row .icon-btn` and
`.send-btn`/`.interrupt-btn` shrinking to 28×28 (`components.css:1240-1242`). So this
specific breakpoint actively makes an already-small target smaller, which is the opposite of
what you'd want on the input method most likely to be used on a phone.

**Fairness caveat:** the row's stated oracle is "~44px" (an Apple-HIG-style guideline, not a
hard requirement in this codebase). WCAG 2.5.8 (AA) only requires 24×24 CSS px, which all
three controls clear. I'm reporting this as a **FAIL against the oracle this row asked me to
use**, not as an accessibility-compliance violation — worth the caller's judgment call on
whether the 44px bar is the right one to hold the composer to.

---

## Console check

No console errors beyond the already-known/filed D15 sessions-404 (see ROW 3) were observed
during this row's driving.

---

## Summary

| Row | Result | Oracle used |
|---|---|---|
| `mobile-390-recheck` / chat feed | **PASS** | `document.scrollWidth<=innerWidth` + per-bubble `getBoundingClientRect` |
| `mobile-390-recheck` / long reply | **FAIL** (long-URL case); list PASS; table untested | DOM ancestor-chain walk (page-level oracle alone would have been a false PASS) |
| `mobile-390-recheck` / sessions drawer | **PASS** (fit/close); D15 (pre-existing, filed) blocks populated-list check | panel/backdrop `getBoundingClientRect`, real backdrop-click + Escape-key close, verified post-settle |
| `mobile-390-recheck` / settings | **PASS** | per-pane `document.scrollWidth`, nav `overflow-x` containment |
| `mobile-390-recheck` / permission dialog | **PASS** | DOM reads across two trials (423-char, then 996-char to force real overflow); button position identical + fully in-viewport in both; log-confirmed clean deny, zero Hermes runs |
| tap targets | **3 FAIL** (mic 32px, mute 32px, send 28px) vs. **3 PASS** (drawer toggle, New chat, row-menu) | `getBoundingClientRect` against the row's stated ~44px bar |

**Net for this dispatch:** the two things this re-check was specifically asked to verify —
the system-event-card removal and the permission-dialog argument rewrite — both hold up at
390px. The permission dialog in particular is solidly built for mobile (bottom-sheet,
correctly-capped internal scroll, buttons genuinely pinned outside the scroll region, verified
non-vacuously with a forced-overflow trial). The two real findings (long-token clipping in chat
bubbles, undersized composer controls) are pre-existing conditions this dispatch happened to
be positioned to catch, not regressions in the two changes under test — flagging them because
the brief asks for anything that "looked odd," not because they're what this row set out to
verify.
