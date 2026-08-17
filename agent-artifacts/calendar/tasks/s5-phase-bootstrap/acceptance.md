# Task Acceptance: Mint calendar capabilities and wire the tool group in phase-services

## Deliverables

- Mint calendar-private and calendar-household capabilities and open their CalendarStores in phase-services, wire the calendar product tool group into the session, and add a calendar config flag, preserving prompt-cache stability.

## Acceptance

- Both calendar capabilities are minted and stores opened per session, mirroring the memory bootstrap
- Calendar tools are wired into the product-tool-provider composition and reachable in a session
- Build is disabled gracefully when calendar is not enabled (config flag)

## Boundary Proof

- phase-services tests cover capability minting, store open, tool wiring, and disabled-flag graceful path
