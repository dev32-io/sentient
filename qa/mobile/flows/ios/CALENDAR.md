# Direct iOS calendar evidence flows

These flows are reusable Maestro steps for the final CAL-UX agent. They do not add a runner command or fault subsystem.

## Safety and fixture lifecycle

Run only against the real local stack. Invoke `bun run calendar:fixture provision --target https://localhost:8888 --state /tmp/calendar-ios-fixture.json` with `CALENDAR_E2E_ADMIN_USER_ID`, `CALENDAR_E2E_ADMIN_PIN`, `CALENDAR_E2E_ADULT_PIN`, and `CALENDAR_E2E_CHILD_PIN` supplied through the environment. The local-only command refuses non-loopback targets and writes IDs only. Invoke `calendar:fixture seed-recovery` after cache prime, and always invoke `calendar:fixture cleanup` from the outer cleanup trap. Keep the disposable iOS adult/child principals exclusive to this run; never share either mutable principal with Android or point the control at production.

Provide only the relevant disposable fixture values through Maestro environment variables (`CALENDAR_EVENT_TITLE`, `CALENDAR_UPDATED_EVENT_TITLE`, `CALENDAR_FILTER_TEXT`, `CALENDAR_ADULT_ONLY_TITLE`, and `CALENDAR_FIRST_ACCOUNT_TITLE`). Do not put credentials, event content, or mutation payloads in logs or committed evidence.

## Orchestration

The final agent runs this inventory only after the Android inventory and its fixture cleanup have completed. Provision a new unique iOS namespace. Run direct files `70` through `82`, including `72c`, `72d`, and `74a`–`74e`; do not use the ordinary tag runner for fault-armed cases.

| Checkpoint | Direct flow(s) | Required direct setup/assertion |
| --- | --- | --- |
| 001–002 | `70-calendar-navigation.yaml`, `71-calendar-preferences-filters.yaml` | Seed paged/dense/adjacent rows and reread restored date/view. |
| 003 | `71-calendar-preferences-filters.yaml` | Supply every supported facet plus an absent selected facet. |
| 004 | `72-calendar-create.yaml`, `72c-calendar-create-all-day-household.yaml`, `72d-calendar-create-recurring.yaml` | Use unique synthetic titles; REST-reread and clean every created event. |
| 005 | `72b-calendar-update.yaml`, `73-calendar-preview-edit-delete.yaml`, `74e-calendar-recurrence-occurrence.yaml`, `74c-calendar-recurrence-following.yaml`, `74d-calendar-recurrence-entire-delete.yaml` | Use independent series and reread occurrence/prefix/successor/deletion identities. |
| 006 | `74a-calendar-conflict-open.yaml`, then `74b-calendar-conflict-resolve.yaml` | **Outside the tag runner**, advance the fixture revision with the existing direct gateway control between the two files. |
| 007 | `78-calendar-child-restriction.yaml` | Login as the disposable child and directly arm the existing typed-forbidden case. |
| 008 | `82a-calendar-cache-prime.yaml` → `82-calendar-cache-first.yaml` → `82b-calendar-cache-recover.yaml` | Prime online, seed a recovery row, make the native path unavailable, relaunch into cached/offline state, restore the path, and observe the offline/stale indicator disappear plus both rows without blanking. |
| 009–010 | `75-calendar-offline.yaml`, `76-calendar-offline-unavailable.yaml` | Prime adjacent cache, make the native path unavailable, assert cached navigation/filtering and disabled writes, and inspect no mutation/queue row. |
| 011 | `75-calendar-offline.yaml` → `77-calendar-reconnect.yaml` | Restore the native path while Calendar remains open; cached and recovery IDs plus the disappearing offline/stale indicator prove uninterrupted automatic revalidation. |
| 012 | `79-calendar-account-isolation.yaml` | Logout A, login independently disposable B offline, inspect B namespace. |
| 013 | `80-calendar-timezone-dst.yaml` | Change device locale/zone; reread fixed all-day date and unchanged event zone/`originalStart`. |
| 014 | `70`, `71`, `73`, `74`, `75`, `76`, `80`, `81` | Repeat exact profiles, Dynamic Type and Reduce Motion; inspect safe areas/semantics. |

For conflict, arm stale revision only between explicit `74a` and `74b` invocations. For CAL-UX-008/011, run `82a`; invoke `seed-recovery` online in the same unique fixture and use its canonical `eventTags` value for `CALENDAR_RECOVERY_EVENT_TAG`; use the existing direct host/simulator network control that makes `NWPathMonitor` report an unavailable path; run `82` and require its offline identifier before restoring that path; then run `82b` without relaunch or Retry and invoke `verify-recovery` against the same authenticated all-scope window. The open-screen variant uses `75`/`77` around the same unavailable→available path edge. Stopping only the gateway is not a valid recovery edge. Do not edit or invoke the ordinary tag runner.

Install an outer cleanup trap that restores the network path before returning from the fixture callback. Then restore account, locale/time zone, content-size category, and Reduce Motion and allow `withLocalCalendarFixture`'s `finally` cleanup to delete only its generated namespace. `78` and `79` require logout/relaunch and disposable child/second-adult login. Run `qa/mobile/validate-calendar-flows.rb` before evidence. Required `CALENDAR_*` values, including `CALENDAR_CACHED_EVENT_TAG` and `CALENDAR_RECOVERY_EVENT_TAG`, are unique synthetic inputs and fixture-derived content-free IDs never shared with Android.

## Visual and semantic matrix

Provision simulator profiles whose **logical** dimensions are exactly `390x844` and `430x932`; record the actual device model and iOS version with each evidence run. Serve the authority with:

```sh
python3 -m http.server 8799 --directory sentient-design
```

Compare each production capture to `http://127.0.0.1:8799/design/mobile/calendar.html`. Capture all four views, filters, dense agenda, preview/editor, recurrence scope, conflict, cached and unavailable offline, default and large accessibility Dynamic Type, and Reduce Motion enabled.

Inspect the accessibility hierarchy and geometry for one calendar scroll region, logical grouping/order, selected/today/outside values, view/filter/freshness announcements, closed overlays, 44pt targets, contrast, home-indicator clearance, keyboard-safe bounded sheets, close/swipe/Cancel behavior, and focus restoration to the exact Add/event opener. Semantic hierarchy inspection is not an actual VoiceOver session and must not be reported as one; an actual VoiceOver run is optional.
