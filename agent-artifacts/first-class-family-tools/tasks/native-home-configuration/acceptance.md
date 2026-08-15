# Task Acceptance: Manage household scenes, automations, scripts, todos, and calendars

## Deliverables

- Family members can inspect, create, modify, and deliberately remove common Home Assistant household configuration through standard Sentient tools without enabling administrative escape hatches.

## Acceptance

- A standard user can discover, inspect, create, and update scene, automation, and script resources without enabling advanced tools
- A standard user can read and manage todos and calendar events under their configured permissions
- A stale configuration update returns conflict and preserves the newer upstream state
- A delete requires the configured confirmation behavior and reports a semantic terminal outcome
- Invalid references or malformed configuration are rejected before HomeAdapter dispatch
- Raw administrative escape hatches remain off and absent from the default model vocabulary

## Boundary Proof

- Contract tests cover valid and invalid scene, script, automation, todo, and calendar schemas at the native boundary
- Fake-adapter state-machine tests cover create/update/delete, optimistic conflicts, validation-before-dispatch, accepted_unverified, and no retry
- Permission tests distinguish routine writes from confirm-level deletes and prove advanced tools default off
- No live HA mutation is used; optional local evidence is limited to reading existing scene/automation/script/todo/calendar metadata
