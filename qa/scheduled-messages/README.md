# Scheduled-message completion QA

Local-only drivers for unresolved scheduled-message E2E oracles. Reports contain commit, HTTP status/counts, content-free IDs explicitly required by proof, and allowlisted state names. Never attach gateway logs, prompts, arguments, tokens, PINs, response bodies, transcripts, or user content.

## Classification checklist

Copy this table into disposable scratch before each run. Every row needs `passed`, `failed (expected/actual+witness)`, `excluded (exact approved platform reason)`, or `blocked (smallest prerequisite+owner)`.

| Case | Required mode | Sub-oracles |
|---|---|---|
| 001 | live web+iOS | once creation, one fresh chat, automatic cleanup, retained card, same-session follow-up |
| 002 | live model | contextual delay; medicine/news recurring not calendar; appointment; event+one reminder; ambiguity clarification; list/edit/pause/resume/delete; recurring retention |
| 003 | live two-user + deterministic calendar | default off; subscriber isolation; omitted update; disable; move; cancellation; deletion; visibility loss; all-day chosen time; one session/occurrence |
| 004 | live web+iOS | cards without push; same-session resume; cold/login URL; safe stale target |
| 005 | live settings + approved exclusions | web deferred disclosure; native actual permission; hidden default; independent controls; no false enablement |
| 007 | live restart + deterministic crash/push | pending/interrupted cleanup; inside/outside grace; recurring advancement; managed push outage; direct+door readiness; exact crash-window/no replay tests |
| 008 | live two-user + deterministic push | authenticated B baseline; A schedule/card/session denial under B token; authority revoked before due; pending unlink/rebinding/logout fencing tests |

## Fresh model probe

Uses existing disposable-user admin lifecycle, ordinary WebSocket chat, real model/tool mediation, and schedule REST readback. Script auto-approves only `scheduled_message_create`. Prompt stays in environment and is never written. Use direct local gateway URL; restart stack from tested checkout first so commit and serving source agree.

```bash
source scripts/env.sh
bun run stack:down && bun run dev
# In another shell after both direct and door /ready return 200:
export SCHEDULE_QA_TARGET=http://127.0.0.1:3000
export SCHEDULE_QA_ADMIN_USER_ID=... SCHEDULE_QA_ADMIN_PIN=...
export SCHEDULE_QA_USER_PIN=1234
export SCHEDULE_QA_PROMPT='synthetic disposable scheduling request'
qa/scheduled-messages/run-model-probe.sh /tmp/model-probe-$(date +%s).json \
  "$HOME/.sentient/gateway/logs/$(date +%F).log"
```

Report distinguishes ordinary input submission, observed model tool JSON, native rejection, permission request/resolution, task terminal state, allowlisted broker diagnostics, and schedule count before/after. `service.code` is `success` only when durable count increases; otherwise it remains `null` rather than inventing a failure code. Preserve report as evidence only after reviewing keys and moving it to a distinct workflow evidence filename.

For each E2E-002 phrase, provision a fresh fixture or first delete its disposable schedules. Record one report per phrase. If task fails, retain matching `toolCallId` and allowlisted stages. Do not add aliases without a witness identifying rejected shape or service code.

## Authenticated account isolation

Create disposable A and B through existing fixture controller. Create A schedule/session through supported UI/API. Run probe with valid B credentials and A content-free IDs:

```bash
SCHEDULE_QA_USER_PIN_B=1234 bun qa/scheduled-messages/auth-isolation-probe.ts \
  --target http://127.0.0.1:3000 --user-id-b "$B_ID" \
  --schedule-id-a "$A_SCHEDULE_ID" --schedule-revision-a "$A_REVISION" \
  --session-id-a "$A_SESSION_ID" --output /tmp/auth-isolation-$(date +%s).json
```

Pass requires B schedules/sessions/cards baseline all `200`, A schedule mutation and session read both safe denial/not-found, and A IDs absent from B lists. Missing/invalid bearer `401` is not this test. Since schedule probe attempts a mutation, A must be disposable. Separately revoke A visibility/user authority before a near-term due claim and pair live absence of A session/card with calendar runner authority tests.

## Calendar lifecycle witnesses

Provision two disposable household adults with `bun run calendar:fixture provision`. For every mutation, capture only event/occurrence/schedule/session IDs, revision, intended timestamp, status, and counts.

1. Create event with reminder omitted. List as A and B; both personal reminders off.
2. Enable A only. Confirm B remains off and has no derived schedule.
3. Update title with reminder omitted; A reminder ID/timing persists. Update `enabled:false`; derived pending schedule disappears.
4. Re-enable with near-term recurring event. Move one occurrence earlier and verify old wake suppresses while new wake creates one session.
5. Cancel another occurrence, delete event, then remove B visibility before due. Each must produce zero new session/provider submission.
6. Create all-day event with explicit `localTime` and IANA zone. Verify derived intended instant and one A-only session.

Use fixture cleanup command in an exit trap. Never remove unrelated users/events.

## Native session links and scheduling

Use current iPhone 16 / iOS 18.3.1 simulator and accessibility IDs `schedule-add`, `schedule-editor`, `schedule-message`, `schedule-save`, and `schedule-cancel`. Enter synthetic text, dismiss focus by tapping `schedule-save`, and require exactly one visible saved row. Exercise invalid correction and retain/retry after stopped local gateway before claiming native create/edit.

Cold-link proof needs no APNs:

```bash
xcrun simctl terminate 'iPhone 16' com.sentient.app
xcrun simctl openurl 'iPhone 16' "sentient://session/$DISPOSABLE_SESSION_ID"
```

Verify same session after login. Safe stale-target plan: create session under disposable A, retain URL, sign out, delete **whole fixture A** through existing admin fixture cleanup (which owns user storage), cold-open URL, then sign in as disposable B. Expect safe unavailable state. This is only supported cleanup seam; no session DELETE exists. If evaluator cannot delete whole fixture while preserving login-routing setup, report fixture prerequisite instead of mutating SQLite or inventing endpoint.

## Restart and readiness

Use only `scripts/stack.sh` lifecycle. Before and after each restart record status code matrix, not bodies:

```bash
scripts/stack.sh status
curl -ksS -o /dev/null -w 'direct health %{http_code}\n' http://127.0.0.1:3000/health
curl -ksS -o /dev/null -w 'direct ready %{http_code}\n' http://127.0.0.1:3000/ready
curl -ksS -o /dev/null -w 'door health %{http_code}\n' https://localhost/health
curl -ksS -o /dev/null -w 'door ready %{http_code}\n' https://localhost/ready
curl -ksS -o /dev/null -w 'install %{http_code}\n' https://localhost/api/v1/install-state
```

Prepare distinct near-term disposable schedules: once pending across restart, inside-grace missed, outside-grace missed, recurring due, and a schedule with push enabled. Stop/start through stack script around intended times; stop managed Gorush through its supported local supervisor only, then restore. Pass requires direct+door ready recovery, one session for eligible work, no old backlog, consumed once/interrupted entries, recurring next run, and cards/chats surviving push outage.

## Deterministic proof commands

Run after source repair; record command, exact commit, pass/fail, test count, and mapped oracle in retained report.

```bash
bun test gateway/src/scheduled-chat/executor.test.ts \
  gateway/src/calendar/calendar-reminder-scheduler.test.ts \
  gateway/src/push/push-store.test.ts \
  gateway/src/push/delivery-service.test.ts \
  gateway/src/push/outbox-drainer.test.ts
./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*PushLifecycleTest*'
./scripts/ios-setup.sh
xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp \
  -destination 'platform=iOS Simulator,arch=arm64,name=iPhone 16,OS=18.3.1' \
  -only-testing:SentientAppTests/NotificationIntegrationTests CODE_SIGNING_ALLOWED=NO
```

Lower-level tests own exact finalization crash windows, no replay, push retry, and pending unlink/rebinding. They do not replace live restart, intent, calendar, navigation, or authenticated isolation journeys.
