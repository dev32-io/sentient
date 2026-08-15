# Testing environment and household safety boundary

## Context

Clarifies which real environments and credentials may be used while delivering and verifying first-class family tools.

## Required Behaviors

- The real local Sentient development stack may be used freely for gateway, web, mobile, API, authentication, profile, session, permission, web-search, and artifact testing.
- The default local-development PIN 1234 may authenticate local test users, but is never treated as a production credential or emitted in logs.
- Production remains observational-only unless the user separately authorizes a specific mutation.
- Local-dev freedom does not override the household-state prohibition: all live HA/MA write-path testing uses mocks, fakes, or isolated fixtures.
- Live HA/MA reads, web search/fetch, music library search/browse, player listing, status, and queue inspection are allowed.

## Acceptance Criteria

- **AC-001:** Local E2E may create or modify local Sentient users, profiles, sessions, permissions, and artifacts using PIN 1234.
- **AC-002:** No test command against live household integrations turns devices on or off, changes climate or other HA state, starts or controls speaker playback, changes volume, mutates or transfers queues, or changes player grouping.
- **AC-003:** HA/MA side-effect behavior is verified through controlled doubles or isolated fixtures.
- **AC-004:** Test automation identifies its target environment and cannot silently redirect a local mutation test to production or live household integrations.
- **AC-005:** Logs and evidence do not expose the local PIN.

## Domain Language

- Local development means the developer-owned Sentient stack and its local application state; it does not include production or permission to mutate live household integrations.
- Household mutation means changing Home Assistant state or Music Assistant playback, volume, queues, transfer, or grouping.

## Actors

- Developer or test agent
- Family members affected by live household integrations

## Scenarios

- A local browser test signs into a development user with PIN 1234 and changes that user's local tool permissions.
- A local E2E creates sessions and web artifacts against the real local stack.
- A live HA check reads whether a light is on but does not call a control service.
- A live MA check searches the library and inspects players or queues but does not start playback or modify music state.
- An HA automation-create or MA playback test substitutes a fake adapter before invoking the write path.

## Edge Cases

- A local Sentient stack is configured with live HA/MA credentials.
- A test target is ambiguous or environment variables point away from the expected local stack.
- The default PIN differs because a developer explicitly changed local configuration.
- A supposedly read-only upstream operation unexpectedly advertises or performs a mutation.

## Out of Scope

- Authorizing production mutations
- Authorizing live household-state mutations
- Treating PIN 1234 as valid outside default local development
