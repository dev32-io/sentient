# Mobile interaction reliability E2E matrix

## Cases

### E2E-001 — Create a genuinely new chat

**Classification:** golden-path

#### Setup

- Use the real local stack and an existing disposable conversation on each mobile platform

#### Actions

- Send marker A in the existing chat
- Tap New Chat
- Immediately send marker B
- Open history and revisit both conversations

#### Expected Outcomes

- A distinct history entry appears
- The old conversation contains marker A but not marker B
- The new conversation contains marker B but not marker A

#### Evidence

- Visible history entries and message separation on iOS and Android

#### Safety

- Use disposable marker text and local state only
- Do not run against production

### E2E-002 — Restart without phantom mint

**Classification:** recovery

#### Setup

- Use the real local stack with one existing disposable conversation

#### Actions

- Open the existing conversation
- Record the visible history count
- Restart the app
- Continue chatting

#### Expected Outcomes

- The app resumes according to lifecycle policy
- Restart creates no extra empty conversation
- The continued message belongs to the resumed conversation

#### Evidence

- History count and restored conversation before and after restart

#### Safety

- Local stack only

### E2E-003 — Repeated New Chat taps

**Classification:** edge

#### Setup

- Use the real local stack from an existing conversation

#### Actions

- Tap New Chat repeatedly before sending
- Send one disposable marker
- Open history

#### Expected Outcomes

- At most one new conversation is created
- The marker is stored in that new conversation rather than the prior one

#### Evidence

- History count and marker location

#### Safety

- Local stack only

### E2E-004 — Send-anchored chat

**Classification:** golden-path

#### Setup

- Open a conversation long enough to scroll

#### Actions

- Send a short message

#### Expected Outcomes

- The new user row lands at the viewport top

#### Evidence

- Visible row position on iOS and Android

#### Safety

- Use disposable local chat content

### E2E-005 — Assistant streams after send

**Classification:** edge

#### Setup

- Continue from a send-anchored conversation and obtain a multi-screen assistant response

#### Actions

- Do not touch the list while the response streams

#### Expected Outcomes

- The viewport remains anchored
- Assistant output extends below naturally without programmatic scrolling

#### Evidence

- Before and after visible viewport anchors

#### Safety

- Local stack only

### E2E-006 — Send long user content

**Classification:** edge

#### Setup

- Open a conversation and prepare disposable user content taller than the viewport

#### Actions

- Paste and send the long content
- Allow assistant activity to begin

#### Expected Outcomes

- The beginning of the user row anchors at the top
- The viewport remains stable during subsequent assistant activity

#### Evidence

- Visible top content and stable anchor

#### Safety

- Do not use private or production content

### E2E-007 — Filter Fish catalog

**Classification:** golden-path

#### Setup

- Run the real local stack with Fish browsing enabled and available catalog results

#### Actions

- Combine title, language, gender, age, vibe, and sort controls
- Observe results and active filter state
- Reset all filters

#### Expected Outcomes

- Results and controls match web semantics
- Reset restores default controls and ordering

#### Evidence

- Visible filters and result titles compared with web behavior

#### Safety

- Browsing only; cloning is not required
- Do not expose Fish credentials in evidence

### E2E-008 — Back from clone editor

**Classification:** recovery

#### Setup

- Load Fish results, apply filters and sort, and scroll away from the initial position

#### Actions

- Open a result's clone editor
- Invoke Back

#### Expected Outcomes

- Back returns to the same filtered Fish result page
- Query, facets, sort, loaded results, and scroll position are restored

#### Evidence

- Visible restored state and route trace

#### Safety

- No clone or remote mutation is required

### E2E-009 — Nested settings navigation

**Classification:** golden-path

#### Setup

- Open Settings on each platform

#### Actions

- Traverse representative category, subpage, result, and editor routes
- Use both top-bar and native Back affordances

#### Expected Outcomes

- Each Back reveals exactly the preceding visible page
- No Back action jumps directly to the Settings root unless it is the actual previous page

#### Evidence

- Route sequence on iOS and Android

#### Safety

- Avoid changing persisted settings

### E2E-010 — Load existing conversation

**Classification:** recovery

#### Setup

- Have at least one existing local conversation with enough content to scroll

#### Actions

- Open or switch to the existing session
- Observe initial position
- Allow subsequent assistant activity

#### Expected Outcomes

- Initial load may land at the latest message
- Later assistant activity does not trigger follow-scrolling

#### Evidence

- Initial and post-load visible anchors

#### Safety

- Local stack only

## Scope

- Driveable local iOS and Android conversation-boundary, scrolling, Fish filtering, and settings-navigation journeys
- Physical microphone input, acoustic waveform quality, real-device capture startup timing, spoken-turn recognition, and production testing are excluded from agent-driven E2E
- The user will manually verify on physical devices that hold-to-talk during TTS stops playback and captures the same press, release submits the newly spoken turn, the waveform responds naturally to silence, quiet speech, and louder speech, and continuous or duplex capture remains usable

## Safety

- All E2E cases run only against the real local stack
- Never retain credentials, raw audio, private transcripts, or production user content
- Automated checks cannot prove real microphone routing, acoustic response, or device-specific timing; that residual risk is explicitly accepted for user-owned final manual testing
