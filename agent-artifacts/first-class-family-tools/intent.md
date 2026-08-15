# Intent: First-class web, home, and music tools

## Problem

Sentient's core web, Home Assistant, and Music Assistant capabilities depend on MCP discovery and upstream tool schemas, causing missing tools, high latency, excessive prompt context, multi-call model orchestration for common intents, and unreliable completion reporting.

## Desired Outcome

Family members receive fast, reliable, context-efficient Sentient-owned web, home, and music tools, while retaining broad capability, centralized per-group/per-tool permissions, and general third-party MCP extensibility.

## Scope — Included

- First-class web search, content extraction, bounded artifact retrieval, and utility-model synthesis
- A generalized outbound worker behind the existing egress proxy, with SearXNG retained as an internal backend
- Sentient-owned Home Assistant tools for household observation, control, scenes, automations, scripts, todos, calendars, and permitted cameras
- Sentient-owned Music Assistant tools combining common intents with standard discovery, playback, status, queue inspection, transfer, and grouping primitives
- Transport-independent product tool groups with per-group and per-tool allow, ask, deny, and off settings
- Migration away from the fetch, SearXNG, Home Assistant, and Music Assistant MCP model surfaces without removing general MCP support

## Success Signals

- Core tools are available without MCP discovery or adapter schema listing
- A common request such as playing music in a room normally requires one model tool call
- The model can still perform standard music discovery, judgement, direct play, status, queue inspection, transfer, and grouping without enabling advanced tools
- Scenes, scripts, and automations are discoverable, runnable, and configurable without enabling administrative escape hatches
- Grounded web answers are concise and cited while complete fetched content remains retrievable outside session context
- Home and music actions report semantic outcomes including accepted-but-unverified instead of equating transport success with completion
- Settings consistently govern built-in and MCP tools by stable product group and tool identity

## Scope — Excluded

- Removing general third-party MCP extensibility
- Home Assistant ambient-event behavior
- Rebuilding SearXNG
- Unattended runtime threat-feed updates
- Making broad HA administration and raw configuration default-visible tools

## Constraints

- Full web pages must not enter the main model context implicitly
- Advanced tools default off and are omitted from the model vocabulary until enabled
- All execution remains mediated by immutable user authority, role reach, and per-tool permission at dispatch
- External content and utility-model summaries remain untrusted and cross established scanning boundaries
- Live testing must never mutate the user's household state; write-path verification uses mocks or fakes, while read-only observation is allowed
- Existing user permission intent must migrate without silently widening access
