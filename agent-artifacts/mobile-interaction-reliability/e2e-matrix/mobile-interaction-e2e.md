# Mobile interaction reliability E2E matrix

## Cases

### E2E-001 — User-triggered New Chat creates a separate conversation

**Classification:** golden-path

#### Setup

- Use the real local stack and an existing disposable conversation on each mobile platform

#### Actions

- Send marker A in the existing chat
- Tap New Chat
- Immediately send marker B without waiting for preparation
- Open history and revisit both conversations

#### Expected Outcomes

- The composer accepts marker B immediately while preparation settles
- A distinct durable history entry appears after marker B
- The old conversation contains marker A but not marker B
- The new conversation contains marker B but not marker A

#### Evidence

- Visible history entries and message separation on iOS and Android

#### Safety

- Use disposable marker text and local state only
- Do not run against production

### E2E-002 — Cold launch eagerly prepares a fresh chat

**Classification:** recovery

#### Setup

- Use the real local stack with an existing disposable conversation containing marker A

#### Actions

- Terminate the app
- Relaunch it
- Immediately send marker B without waiting
- Open history and revisit the pre-launch and post-launch conversations

#### Expected Outcomes

- Relaunch opens a clear fresh-chat surface rather than resuming the old timeline
- The composer accepts marker B immediately while the eager gateway handshake settles
- Marker B creates and belongs to a distinct new durable conversation
- The pre-launch conversation still contains marker A and does not contain marker B

#### Evidence

- Fresh launch surface, history entries, and old/new message separation

#### Safety

- Local stack only
- Use disposable marker text

### E2E-003 — Repeated New Chat taps remain bounded

**Classification:** edge

#### Setup

- Use the real local stack from an existing conversation

#### Actions

- Tap New Chat repeatedly before sending
- Send one disposable marker
- Open history

#### Expected Outcomes

- Existing idempotence/debounce prevents duplicate effective preparation for the rapid action
- At most one new durable conversation is created from the final marker
- The marker is stored in the fresh conversation rather than the prior one

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

### E2E-010 — Load an existing conversation

**Classification:** recovery

#### Setup

- Have at least one existing local conversation with enough content to scroll

#### Actions

- Open the existing session from history
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

- Fully agentic local iOS and Android fresh-chat lifecycle, conversation-boundary, scrolling, Fish filtering, and settings-navigation journeys that can run to completion without user intervention
- Physical microphone input, acoustic waveform quality, real-device capture startup timing, spoken-turn recognition, user-assisted verification, and production testing are excluded

## Safety

- Every listed case must be executable end-to-end by an agent without user intervention
- All E2E cases run only against the real local stack
- Never retain credentials, raw audio, private transcripts, or production user content
- Do not create workflow checkpoints that wait for physical-device microphone or acoustic validation
