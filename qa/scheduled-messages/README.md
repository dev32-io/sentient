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
# In another shell after both direct and door /api/v1/ready return 200:
# Override only for an explicitly configured isolated loopback endpoint.
export SCHEDULE_QA_TARGET=https://localhost:8888
export SCHEDULE_QA_ADMIN_USER_ID=... SCHEDULE_QA_ADMIN_PIN=...
export SCHEDULE_QA_USER_PIN=1234
export SCHEDULE_QA_PROMPT='synthetic disposable scheduling request'
qa/scheduled-messages/run-model-probe.sh /tmp/model-probe-$(date +%s).json \
  "$HOME/.sentient/gateway/logs/$(date +%F).log"
```

Report distinguishes ordinary input submission, observed model tool JSON, native rejection, permission request/resolution, task terminal state, allowlisted broker diagnostics, and schedule count before/after. `service.code` is `success` only when durable count increases; otherwise it remains `null` rather than inventing a failure code. Submit reviewed, selected sanitized witnesses through current `e2e_workspace` evidence/report capability; do not copy output into canonical reports or choose retained filenames manually.

For each E2E-002 phrase, provision a fresh fixture or first delete its disposable schedules. Record one report per phrase. If task fails, retain matching `toolCallId`, allowlisted issue paths/codes and stages, permission outcome, safe domain error code, event/reminder/job counts, and intended timing. Do not add aliases without a witness identifying rejected shape or service code. Exercise list/edit/pause/resume/delete through ordinary model chat and approval; direct REST calls may corroborate state but do not satisfy model-driven lifecycle proof.

## Authenticated account isolation

Create disposable A and B through existing fixture controller. Create A schedule/session through supported UI/API. Run probe with valid B credentials and A content-free IDs:

```bash
SCHEDULE_QA_USER_PIN_B=1234 bun qa/scheduled-messages/auth-isolation-probe.ts \
  --target https://localhost:8888 --user-id-b "$B_ID" \
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
5. For visibility loss, enable a reminder for the eventual subscriber while the event is visible. Use supported fixture role update so that subscriber no longer qualifies for `adults`, then change event visibility to `adults` before due. Prove the subscriber still has an authenticated API baseline but can no longer read the event and produces zero new session/card/provider submission. Changing `everyone` to `adults` while the subscriber is still an adult proves nothing.
6. Cancel another occurrence and delete an event before due; each must produce zero new session/provider submission.
7. Create all-day event with explicit `localTime` and IANA zone. Verify derived intended instant and one A-only session.

Use fixture cleanup command in an exit trap. Never remove unrelated users/events.

## Native session links and scheduling

Use current iPhone 16 / iOS 18.3.1 simulator and accessibility IDs `schedule-add`, `schedule-editor`, `schedule-message`, `schedule-delay`, `schedule-save`, and `schedule-cancel`. With Maestro `eraseText` or XCUITest select-all/delete, replace delay contents, type a decimal such as `1`, and assert field value is exactly `1` before Save. First prove malformed input stays in editor with validation, then correct it; require editor dismissal and exactly one visible saved row. Retain sanitized field value/type, validation state, and resulting row count. Retain/retry after stopped local gateway before claiming native create/edit.

Cold-link proof needs no APNs:

```bash
xcrun simctl terminate 'iPhone 16' io.dev32.sentient.debug
xcrun simctl openurl 'iPhone 16' "sentient://session/$DISPOSABLE_SESSION_ID"
```

Verify same session after login. Safe stale-target plan: create session under disposable A, retain URL, sign out, delete **whole fixture A** through existing admin fixture cleanup (which owns user storage), cold-open URL, then sign in as disposable B. Expect safe unavailable state. This is only supported cleanup seam; no session DELETE exists. If evaluator cannot delete whole fixture while preserving login-routing setup, report fixture prerequisite instead of mutating SQLite or inventing endpoint.

## Restart and readiness

Use only `scripts/stack.sh` lifecycle. Before and after each restart record status code matrix, not bodies:

```bash
scripts/stack.sh status
curl -ksS -o /dev/null -w 'direct health %{http_code}\n' https://localhost:8888/api/v1/health
curl -ksS -o /dev/null -w 'direct ready %{http_code}\n' https://localhost:8888/api/v1/ready
curl -ksS -o /dev/null -w 'door health %{http_code}\n' https://localhost/api/v1/health
curl -ksS -o /dev/null -w 'door ready %{http_code}\n' https://localhost/api/v1/ready
curl -ksS -o /dev/null -w 'install %{http_code}\n' https://localhost/api/v1/install-state
```

Record the isolated `scheduling.missedGraceMs` value before the run. Create distinct future disposable schedules through normal APIs: once pending across restart, inside-grace missed, outside-grace missed, recurring due, and a schedule with push enabled. Stop before due and leave each intended instant to age naturally; never change host time or backdate storage. Allow measured stack startup margin, then start only through the stack script.

Credential-free macOS runs may generate an isolated config containing only public-door infrastructure plus a local `gorush` stand-in. Generator marks only this QA stand-in as infrastructure so fresh pre-wizard fixture roots start it through normal infra-only boot; production Gorush stays unchanged. Generated projection uses a QA-only schema marker so startup operator migrations cannot repopulate stripped production services. Generator rewrites user/shared storage under disposable root, fails closed unless `sandbox-exec` is available, and installs a profile denying all outbound network before launch. `SENTIENT_GATEWAY_ROOT` and `HOST_CONFIG_DIR` must use same root so auth/profile and rendered addon config stay isolated too. Stand-in proves gateway/provider/supervisor outage and recovery only—not Gorush or APNs compatibility:

```bash
export SENTIENT_HOME="$(mktemp -d /tmp/sentient-push-e2e.XXXXXX)"
export SENTIENT_GATEWAY_ROOT="$SENTIENT_HOME/gateway"
export HOST_CONFIG_DIR="$SENTIENT_HOME/gateway/config"
export GATEWAY_CONFIG_PATH="$SENTIENT_HOME/push-fixture-config.yaml"
# Refuse any existing listener. Never put a fake on real Gorush port 8088.
# Native supervisor also rejects—not adopts or signals—an unowned holder.
export PUSH_QA_PORT=18088
if lsof -nP -iTCP:"$PUSH_QA_PORT" -sTCP:LISTEN | grep -q .; then
  echo "refusing occupied managed-push fixture port" >&2
  exit 1
fi
bun qa/scheduled-messages/prepare-managed-push-config.ts \
  --source gateway/config.yaml --output "$GATEWAY_CONFIG_PATH" --state-root "$SENTIENT_HOME" \
  --port "$PUSH_QA_PORT"
scripts/stack.sh up
curl -fsS "http://127.0.0.1:$PUSH_QA_PORT/healthz" >/dev/null
# After push work is pending, fixture-owned stop simulates transport loss.
curl -fsS -X POST "http://127.0.0.1:$PUSH_QA_PORT/qa/stop" >/dev/null
# Observe optional service failure then watchdog-owned restart via status/health.
```

Run `scripts/stack.sh down` with the same isolated environment in an exit trap, then verify its port is free. Do not leave stand-ins running after QA or reuse their accepted receipts as Apple-delivery evidence. The fixture refuses absent ports and port 8088; the generator aligns provider URL, native-service port, and health probe. Default dev/prod gateways never target that port.

Pass requires direct+door ready recovery, one session for eligible work, no old backlog, consumed once/interrupted entries, recurring next run, and cards/chats surviving push outage. Never claim Gorush/APNs compatibility from stand-in. If sandbox or managed fixture cannot execute, record exact prerequisite instead of claiming outage passed.

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
