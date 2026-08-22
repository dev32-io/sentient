# Direct iOS calendar evidence flows

These flows are reusable Maestro steps for the final CAL-UX agent. They do not add a runner command or fault subsystem.

## Safety and fixture lifecycle

Run only against the real local stack. Wrap the complete sequential iOS run in `withLocalCalendarFixture(...)` from `gateway/src/calendar/e2e-helpers.ts`, using a cryptographically unique run namespace and explicit loopback/local target. Keep the disposable iOS adult/child principals exclusive to this run; never share either mutable principal with Android. The fixture callback must finish before cleanup, and cleanup must remain in the adapter's `finally` path. Never point these flows or fixture mutations at production.

Provide only the relevant disposable fixture values through Maestro environment variables (`CALENDAR_EVENT_TITLE`, `CALENDAR_UPDATED_EVENT_TITLE`, `CALENDAR_FILTER_TEXT`, `CALENDAR_ADULT_ONLY_TITLE`, and `CALENDAR_FIRST_ACCOUNT_TITLE`). Do not put credentials, event content, or mutation payloads in logs or committed evidence.

## Orchestration

Run `70`–`81` directly and sequentially. For `74`, arm the stale revision through the local fixture dependency after the editor opens. For `75`–`77`, the agent must stop/restart the existing gateway or simulator network, poll the existing readiness signal, and then invoke the flow; arbitrary sleeps are prohibited. Restore the gateway, simulator network, account, content-size category, and Reduce Motion setting in a guaranteed final cleanup block.

`78` and `79` require relaunch/login with the fixture's disposable child and second adult respectively before running the flow. Account isolation must use separate cache namespaces.

## Visual and semantic matrix

Provision simulator profiles whose **logical** dimensions are exactly `390x844` and `430x932`; record the actual device model and iOS version with each evidence run. Serve the authority with:

```sh
python3 -m http.server 8799 --directory sentient-design
```

Compare each production capture to `http://127.0.0.1:8799/design/mobile/calendar.html`. Capture all four views, filters, dense agenda, preview/editor, recurrence scope, conflict, cached and unavailable offline, default and large accessibility Dynamic Type, and Reduce Motion enabled.

Inspect the accessibility hierarchy and geometry for one calendar scroll region, logical grouping/order, selected/today/outside values, view/filter/freshness announcements, closed overlays, 44pt targets, contrast, home-indicator clearance, keyboard-safe bounded sheets, close/swipe/Cancel behavior, and focus restoration to the exact Add/event opener. Semantic hierarchy inspection is not an actual VoiceOver session and must not be reported as one; an actual VoiceOver run is optional.
