# Task Acceptance: Mint calendar capabilities, wire the tool group, and own calendar config

## Deliverables

- Mint calendar-private and calendar-household capabilities and open their CalendarStores in phase-services, wire the calendar product tool group into the session, close stores on session disposal, and add the orchestratorCfg.calendar config (schema, defaults, old-config compatibility; default event tz id resolves to the household tz via resolveTimeZone()), preserving prompt-cache stability.

## Acceptance

- Both calendar capabilities are minted and stores opened per session, mirroring the memory bootstrap, with stores closed on session disposal
- Calendar tools are wired into the product-tool-provider composition and reachable in a session
- orchestratorCfg.calendar (enabled, recurrence limits, nudge budget, default event tz id) is defined in the config schema and defaulted in gateway/config.yaml; the default event tz id resolves to the household tz via the existing resolveTimeZone() seam; an older config with no calendar block still boots
- The session system prompt is still composed once; calendar writes do not mutate it within the session

## Boundary Proof

- phase-services tests cover capability minting, store open, tool wiring, store close on disposal, disabled-flag graceful path, config schema/defaults, old-config compatibility, default event tz id resolving to household tz, and once-per-session prompt composition
