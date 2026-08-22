# Evaluation Report: stage-stage-7-mobile-data-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- Stateless repository passthrough and explicit exported use-case interfaces for platform ViewModels
- DI wiring exposes calendar to platform screens without restart-mutation assumptions

## Observations

MERGE: NO

CalendarRepository/SdkCalendarRepository implement stateless CRUD passthrough and SentientResult mapping. Explicit use-case interfaces are exported, read state is use-case-owned, and SettingsComponent wires the client/repository/use cases. Required stage checks pass.

Major finding S7-MD-001 blocks merge: calendar operations inherit the SettingsComponent's shared HttpClient, whose documented timeout is ~60-120s for restart-blocking profile mutations. CalendarHttpClient has no calendar-specific bounded timeout/cancellation, violating the explicit requirement that calendar CRUD not inherit restart-mutation assumptions.

## Evidence

- **EV-001:** ./gradlew :shared:mobile-data:testDebugUnitTest --tests '*Calendar*' — BUILD SUCCESSFUL
- **EV-002:** ./gradlew :shared:mobile-data:compileDebugKotlin — BUILD SUCCESSFUL
- **EV-003:** git diff --check 55f2285a205b2266eb09d50eaa54b33b78b2a4db 96456967876f694f4ad1921d115c8c4bcc1746e6 — clean

## Findings

- **S7-MD-001** (high, open): Calendar uses the shared restart-timeout HttpClient without a calendar-specific bounded timeout.

## Verdict

fail

## Residual Risk

- The added tests cover get mapping and list-state folding, but do not exercise mapping for list/create/update/delete; this is non-blocking because the passthrough implementations are direct and the declared checks pass.
