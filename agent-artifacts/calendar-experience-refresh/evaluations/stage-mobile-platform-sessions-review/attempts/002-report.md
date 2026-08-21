# Evaluation Report: stage-mobile-platform-sessions-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Explicit AuthUser.userId plus normalized backend identity reaches both session boundaries before namespace derivation
- Android app-private AndroidSqliteDriver and iOS Application Support NativeSqliteDriver/Data Protection
- Authenticated-session lifetime, cancellation-before-purge, non-cancelled bounded purge/switch, close, and account/backend isolation
- No platform types in commonMain, native cache/policy duplication, SQLCipher, external storage, content-bearing paths, or diagnostics

## Observations

MERGE: NO
Closure re-review of repair 71c3ef5d2bd956027f313ad5d82a9e01b3fa6b69 as contained in reviewed commit 43ffe303b02d8ffda10c525be9a7b7094a42db10. MPS-001 through MPS-004 are resolved: fail-closed dependency wiring, real Android/iOS lifecycle proof, structural diagnostics/redaction, and asynchronous off-main initialization are present and their checks pass. However, the repair introduces MPS-005: Android and iOS use a non-atomic final liveness check followed by runtime publication, so logout/close can capture and queue teardown for null, then receive a late runtime that is marked transferred and never purged. This is a blocking Major repair regression against purge ordering and stale-emission isolation.

## Evidence

- **EV-001:** Declared Android/shared stage check — PASS; BUILD SUCCESSFUL
- **EV-002:** Declared iOS setup check — PASS; project and XCFramework setup completed
- **EV-003:** Declared iOS simulator test check — PASS; 82 tests
- **EV-004:** Additional real AndroidSqliteDriver lifecycle proof — PASS; 3 instrumentation tests
- **EV-005:** Declared cleanliness check — PASS; worktree clean

## Findings

- **MPS-001** (high, resolved): Protected session settings now use a disabled repository delegate until database setup installs the shared experience; the fallback test proves zero network calls.
- **MPS-002** (high, resolved): The required real-driver Android instrumentation and iOS driver/store/session lifecycle tests are present and pass.
- **MPS-003** (high, resolved): Transport and app diagnostics now use normalized endpoint identities, structural error codes, and endpoint secret redaction tests pass.
- **MPS-004** (high, resolved): Initialization and disposal are queued on background executors without caller-blocking database setup; thread assertions pass.
- **MPS-005** (high, open): A close can clear/capture a null runtime after initialization passes its final liveness check; initialization can then publish and transfer that runtime after teardown is queued. The late driver/experience is not owned by purge and can emit after logout; Android can expose it through the shared manager to a successor session.

## Verdict

fail

## Residual Risk

- The passing lifecycle tests do not exercise the close-versus-initialization interleaving in MPS-005.
