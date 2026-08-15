# First-class family tool behavior

## Context

Defines user-visible behavior for Sentient-owned web, Home Assistant, Music Assistant, and permission surfaces that replace these core MCP model surfaces.

## Required Behaviors

- web_search queries SearXNG, selects bounded sources, optionally fetches relevant content, and returns a concise cited answer without placing complete pages in the conversation.
- fetch_content stores full extraction outside session context and returns bounded content plus an artifact identifier; read_web_content retrieves bounded slices or matching passages.
- Web synthesis first tries the user's selected model, then the configured DeepSeek Flash utility fallback, then deterministic snippet/source formatting.
- The outbound worker is the only public-web execution surface offered to tools; it accesses the internet through the existing egress proxy and enforces scheme, port, DNS, dangerous-domain, redirect, timeout, and byte limits.
- music_play resolves natural-language media and room/player intent, applies queue behavior internally, starts playback, and verifies resulting state where possible.
- Standard music tools include search, browse, player discovery, status, direct play, playback control, volume, queue inspection, queue transfer, and common grouping.
- Standard home tools cover overview, search, state, history, areas, zones, routine controls, scenes, automations, scripts, todos, calendars, and permitted cameras.
- Scenes, automations, and scripts support discovery, activation, inspection, creation, and modification without enabling administrative tools.
- Administrative escape hatches such as raw YAML/file edits, raw WebSocket commands, system updates/restarts/add-ons, registry deletion, arbitrary templates, and custom code default off.
- Every tool is governed by role reach plus per-group and per-tool allow, ask, deny, or off settings; off removes the definition from the model vocabulary and dispatch rechecks the decision.
- General third-party MCP tools remain supported and use the same permission decision boundary.
- Live verification may observe the user's real home but must never mutate it; all HA/MA write-path tests use mocks, fakes, or isolated fixtures.

## Acceptance Criteria

- **AC-001:** Core web, home, and music definitions are produced without contacting their former MCP adapters.
- **AC-002:** A request to play a natural-language music selection in a named room can complete through one music_play invocation when resolution is unambiguous.
- **AC-003:** After a music search or browse, the model can inspect players/status/queue and directly play or transfer the selected media using standard tools.
- **AC-004:** A user can discover and activate a scene or automation and create or modify automation, scene, or script configuration without enabling advanced tools.
- **AC-005:** A grounded search result contains a bounded answer and citations; complete fetched source text is absent unless explicitly retrieved through its artifact identifier.
- **AC-006:** A dangerous-domain denial applies to the initial fetch target and every redirect using canonical suffix-aware matching.
- **AC-007:** When a side-effecting adapter loses confirmation after dispatch, the result reports accepted-but-unverified and is not transparently retried.
- **AC-008:** Changing a group or tool permission changes both next-turn visibility and dispatch authorization; advanced tools are absent for profiles that have not enabled them.
- **AC-009:** Migrated profiles preserve restrictive settings and never gain a tool they had explicitly denied or switched off.
- **AC-010:** No live test command changes Home Assistant state, music playback, speaker volume, queue contents, queue location, or player grouping.

## Domain Language

- Product tool group is the stable permission namespace presented to users; it is independent of transport and execution adapter.
- Standard tool is visible by default when role and permission allow it; advanced tool defaults off and contributes no model context until enabled.
- Web artifact is full extracted source content stored outside conversation context and addressed by an opaque, user-scoped identifier.
- Grounded web answer is a concise synthesis derived from bounded source passages with source citations.
- Semantic action outcome describes whether the household intent succeeded, was rejected, was ambiguous, failed, was unavailable, or was accepted but could not be verified; transport success alone is not semantic success.

## Actors

- Family member using voice, web, or mobile chat
- Household administrator configuring tool permissions
- Sentient ReAct model selecting tools
- Operator maintaining outbound and dangerous-domain policy

## Scenarios

- A family member asks for current information; Sentient searches, fetches selected sources within bounds, summarizes through the utility runner, and cites sources.
- The selected summarization model fails; DeepSeek Flash succeeds without involving the main ReAct loop.
- Both utility models fail; the family member receives a deterministic source summary instead of a failed or context-bloating tool result.
- A fetched page redirects to a known dangerous domain; the worker refuses that hop and reports the source as blocked while preserving other search results.
- A family member asks to play lo-fi in the living room; music_play resolves media and player, begins playback, verifies it, and returns playing.
- A family member dislikes the current track; the model searches or browses alternatives, judges results, and directly plays one without enabling advanced tools.
- A family member asks to move current playback to another room; the standard queue-transfer capability performs and verifies the move.
- A family member asks to activate movie night; home discovery resolves the scene and a dedicated activation tool runs it.
- A family member asks for a porch-light-at-sunset automation; a standard configuration tool validates names and structure, writes the automation after permission mediation, and returns its identifier.
- During testing, an engineer reads light state and searches music against live services but uses fakes for activation and playback paths.

## Edge Cases

- Search returns no results, some sources fail, or all page fetches time out.
- Artifact retrieval uses an expired, foreign-user, malformed, or out-of-range identifier.
- A media request, room, entity, scene, or automation has zero or multiple matches.
- A player is unavailable or a command is accepted but verification cannot establish its outcome.
- A profile changes permissions between tool advertisement and dispatch.
- A dangerous domain appears through case variation, trailing dot, IDNA representation, subdomain, or redirect.
- The outbound worker, egress proxy, SearXNG, HA, MA, selected utility model, or fallback utility model is unavailable.
- An upstream HA or MA response violates the adapter's expected schema.
- Legacy permissions refer to removed MCP names or tools without a direct replacement.

## Out of Scope

- Ambient Home Assistant event reactions
- General HA system administration as default-visible capability
- Automatic threat-feed updates without operator control
- Replacing SearXNG
- Eliminating general MCP support
