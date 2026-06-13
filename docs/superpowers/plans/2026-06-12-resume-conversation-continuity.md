# Resume Conversation Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a WS reconnect, continue the same Hermes conversation instead of forking a new one, by having the client assert the conversationId it is displaying inside `session.configure` and the gateway seeding the re-anchor before the `recovered:true` early-return.

**Architecture:** One continuity token (`conversationId` = ACP/Hermes session id). The client (which already holds the current id) declares it in the configure frame; the gateway seeds `pendingNewSessionId` from it (falling back to the existing `?session_id=` query param), placed before `ws-session-configure.ts:932` so it applies to warm (buffer-resume) reconnects. The next message rides the existing `resolveAcpSessionId` → forcedSessionId rail (warm continue, or Hermes `session/load` for evicted threads). See `docs/superpowers/specs/2026-06-12-resume-conversation-continuity-design.md`.

**Tech Stack:** Bun/TypeScript gateway, zod wire schemas (`shared/protocol`), Kotlin Multiplatform mobile SDK (`shared/mobile-sdk`), Maestro for native E2E.

**Test runners:** protocol → `bun run test` (vitest) in `shared/protocol`; gateway → `cd gateway/src && bun test` (native bun runner — NOT vitest); mobile-sdk → `./gradlew :shared:mobile-sdk:testDebugUnitTest` (or the commonTest task). Source `scripts/env.sh` first.

---

## Task 1: Protocol — optional `conversationId` on `session.configure`

**Files:**
- Modify: `shared/protocol/src/messages.ts:81-102` (`sessionConfigureSchema`)
- Test: `shared/protocol/src/messages.test.ts`

- [ ] **Step 1: Write the failing test** — append to `messages.test.ts`:

```ts
it("accepts session.configure with an optional conversationId", () => {
  const result = sessionConfigureSchema.safeParse({
    type: "session.configure",
    capabilities: { supports: [] },
    clientType: "mobile",
    deviceId: "dev-1",
    conversationId: "conv-abc",
  });
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.conversationId).toBe("conv-abc");
});

it("accepts session.configure with conversationId omitted (back-compat)", () => {
  const result = sessionConfigureSchema.safeParse({
    type: "session.configure",
    capabilities: { supports: [] },
    clientType: "webui",
    deviceId: "dev-1",
  });
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.conversationId).toBeUndefined();
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd shared/protocol && bun run test messages` → FAIL (conversationId stripped / unknown).

- [ ] **Step 3: Add the field** — in `sessionConfigureSchema`, after the `resume:` line (messages.ts:101):

```ts
  /**
   * Optional — the conversationId (Hermes thread id) the client is currently
   * displaying. Sent on (re)connect so the gateway can re-anchor the thread for
   * the next message instead of forking. The client only ever supplies an id it
   * received via session.created / session.switched. Omitted on a fresh chat.
   */
  conversationId: z.string().min(1).optional(),
```

- [ ] **Step 4: Run it, verify it passes** — `cd shared/protocol && bun run test messages` → PASS.

- [ ] **Step 5: Commit** — `git add shared/protocol/src/messages.ts shared/protocol/src/messages.test.ts && git commit -m "feat(protocol): optional conversationId on session.configure"`

---

## Task 2: Gateway — thread the field + early re-anchor seed

**Files:**
- Modify: `gateway/src/session-handlers/ws-handlers.ts:109-117` (pass `msg.conversationId`)
- Modify: `gateway/src/session-handlers/ws-session-configure.ts:78-86` (signature) and a seed block before line 914

- [ ] **Step 1: Extend the handler signature** — `ws-session-configure.ts:78-86`, add a param after `configureResume`:

```ts
export async function handleSessionConfigure(
  ws: ServerWebSocket<ClientData>,
  capabilities: readonly string[],
  language: "en" | "zh",
  services: GatewayServices,
  clientType: ClientType,
  configureDeviceId: string,
  configureResume: SessionConfigureResume | undefined,
  configureConversationId: string | undefined,
): Promise<void> {
```

- [ ] **Step 2: Pass it from the caller** — `ws-handlers.ts:109-117`, add `msg.conversationId` as the last arg:

```ts
      await handleSessionConfigure(
        ws,
        msg.capabilities.supports,
        msg.language,
        services,
        msg.clientType,
        msg.deviceId,
        msg.resume,
        msg.conversationId,
      );
```

- [ ] **Step 3: Seed the re-anchor before the resume handshake** — in `ws-session-configure.ts`, immediately BEFORE `const replayed = handleResumeOrFresh({` (line 914), insert:

```ts
  // Re-anchor the conversation thread for the NEXT user message. The client
  // declares the conversationId it is displaying (configure field, mobile) or
  // via the ?session_id= upgrade param (web). Seed it HERE — before the
  // recovered:true early-return below — so a warm buffer-resume reconnect still
  // continues the same Hermes thread instead of forking. The next cycle's
  // resolveForcedSessionId consumes this; an unknown id degrades to a fresh
  // Hermes session/load (per-user worker isolation makes a stale id harmless).
  const reanchorConversationId = configureConversationId ?? ws.data.resumeSessionId;
  if (reanchorConversationId !== null && reanchorConversationId !== undefined) {
    pendingNewSessionId = reanchorConversationId;
    log.info("resume.reanchor", {
      sessionId,
      conversationId: reanchorConversationId,
      source: configureConversationId ? "configure" : "url",
    });
  }
```

> Note: `pendingNewSessionId` is the `let` declared at line 160 — assign it directly; it is captured by the `onCycle` closure (line 637) which reads it at next-message time. The existing `?session_id=` activate block (line 963) is left intact (it additionally rehydrates history on the non-replayed path; its re-seed is now a harmless same-id no-op).

- [ ] **Step 4: Typecheck + gateway tests** — `source scripts/env.sh && bun run typecheck` (clean) then `cd gateway/src && bun test` (all green — adding an optional trailing param + a seed must not break existing session-configure tests).

- [ ] **Step 5: Manual contract check (no new unit test)** — per the test-lean doctrine the seed is a one-line `??` with no isolated unit worth pinning; its behavior is covered by the E2E in Task 5 and the protocol contract test in Task 1. Confirm by reading: on a `recovered:true` resume with `configureConversationId` set, `pendingNewSessionId` is non-null before the early `return` at line 932.

- [ ] **Step 6: Bump gateway version** — `gateway/package.json:3` `"version": "1.11.1"` → `"1.11.2"`.

- [ ] **Step 7: Commit** — `git add gateway/src/session-handlers/ws-session-configure.ts gateway/src/session-handlers/ws-handlers.ts gateway/package.json && git commit -m "fix(gateway): re-anchor conversation on warm reconnect; bump 1.11.2"`

---

## Task 3: Mobile SDK — send `conversationId` in configure

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol/ClientMessage.kt:19-37` (`SessionConfigure`)
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkLifecycle.kt:143-153` (`sendConfigure`) + its hooks
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt` (wire the `currentConversationId` hook from `_currentSessionId`)
- Test: `shared/mobile-sdk/src/commonTest/.../SdkResumeReconciliationTest.kt` (extend) — assert configure carries the current conversation id on reconnect.

- [ ] **Step 1: Write the failing test** — in the mobile-sdk commonTest resume/reconciliation suite, add a case: given an anchored conversation (`_currentSessionId = "conv-A"`), when the SDK reconnects and sends `session.configure`, the emitted configure frame carries `conversationId = "conv-A"`. Use the existing fake transport/`fake.sentText` helpers in that suite. Name: `it/“configure carries current conversationId on reconnect”`.

- [ ] **Step 2: Run it, verify it fails** — `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*Resume*'` → FAIL (field absent).

- [ ] **Step 3: Add the serializable field** — `ClientMessage.kt`, in `SessionConfigure` add a nullable, default-null field mirroring the existing `resume` field's nullability/omit-if-null pattern:

```kotlin
    @SerialName("conversationId") val conversationId: String? = null,
```

(Keep it last; ensure the serializer omits it when null — same config the nullable `resume` already relies on.)

- [ ] **Step 4: Add a hook + source it from current session** — in `SdkLifecycle.kt`'s hooks interface add `fun currentConversationId(): String?`; in `sendConfigure` (143-153) pass `conversationId = hooks.currentConversationId()`. In `SentientSdk.kt`, implement the hook as `_currentSessionId.value`.

```kotlin
sendConfigure = {
    ClientMessage.SessionConfigure(
        capabilities = Capabilities(hooks.mergedCapabilities()),
        clientType = CLIENT_TYPE_MOBILE,
        deviceId = deviceId,
        resume = hooks.resumeParams(),
        conversationId = hooks.currentConversationId(),
    )
}
```

- [ ] **Step 5: Run it, verify it passes** — `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests '*Resume*'` → PASS. Then full SDK suite green: `./gradlew :shared:mobile-sdk:testDebugUnitTest`.

- [ ] **Step 6: Bump mobile versions** —
  - `shared/mobile-sdk/build.gradle.kts:12` `version = "0.1.0"` → `"0.1.1"`
  - `android/build.gradle.kts:27` `versionCode = 2` → `3`, `versionName = "0.1.0"` → `"0.1.1"`
  - `ios/project.yml:24` `CFBundleShortVersionString: 0.1.0` → `0.1.1`

- [ ] **Step 7: Commit** — `git add shared/mobile-sdk android/build.gradle.kts ios/project.yml && git commit -m "fix(mobile-sdk): assert current conversationId in session.configure; bump apps 0.1.1"`

---

## Task 4: E2E — Maestro warm-reconnect-continues (Android + iOS)

> Owned by the agent (see `.claude/rules/e2e-testing.md` + `.claude/rules/mobile/*`). Drive against the running local stack (`deploy/macos`), real services, free credentials (PIN 1234). Capture evidence under the mobile QA dir.

**Files:**
- Create: `qa/mobile/flows/android/04c-reconnect-continue-conversation.yaml`
- Create: `qa/mobile/flows/ios/04c-reconnect-continue-conversation.yaml`
- Reference existing: `qa/mobile/flows/{android,ios}/04-reconnect.yaml`, `04b-reconnect-recover.yaml` for the background/foreground + assertion idiom.

- [ ] **Step 1: Boot the local stack** — `deploy/macos` up; gateway healthy at 1.11.2; build+install signed app (NEVER `CODE_SIGNING_ALLOWED=NO`).

- [ ] **Step 2: Author the flow** — in chat A: send a turn, await reply, exchange one more so context exists. Background the app (HOME / lock), wait, foreground (warm reconnect → `recovered:true`). Send a follow-up that depends on prior context. Assert: reply renders in chat A, references prior context, and the drawer has **no new row**.

- [ ] **Step 3: Run Android** — `adb` device; `maestro test qa/mobile/flows/android/04c-reconnect-continue-conversation.yaml`. Capture screenshots + `logcat`.

- [ ] **Step 4: Run iOS** — `xcrun simctl` device; `maestro test qa/mobile/flows/ios/04c-reconnect-continue-conversation.yaml`. Capture screenshots + `os_log`.

- [ ] **Step 5: Verify the gateway log trail** — in `gateway/logs/<today>.log`: configure carries `conversationId`; `resume.reanchor source=configure`; the follow-up `dispatch.begin` uses the forced id; **no `dispatch.session-new.lazy`**; same conversationId across both turns; no unexpected WARN/ERROR.

- [ ] **Step 6: Sad-path cases** — (a) fresh/empty chat reconnect → still mints a new conversation (no spurious continue); (b) if reachable, an evicted-buffer (`recovered:false`) reconnect → continues via `session/load`. Flag any case unreachable in the harness in handover.

- [ ] **Step 7: Commit evidence + flows** — `git add qa/mobile/flows && git commit -m "test(mobile-e2e): warm-reconnect continues the same conversation"`

---

## Pre-handover gate

- Every E2E case green (Android + iOS), evidence captured.
- `bun run lint` + `bun run typecheck` clean; `cd gateway/src && bun test` green; `./gradlew :shared:mobile-sdk:testDebugUnitTest` green; `shared/protocol` tests green.
- Versions bumped: gateway 1.11.2; mobile-sdk + android + ios 0.1.1.
- No partial green. Branch left for the user to review/merge — do NOT merge or deploy without explicit go.

## Self-review (DRY / placeholders / type consistency)

- New param `configureConversationId` type matches the schema (`string | undefined`).
- Field name `conversationId` consistent across protocol, gateway, mobile.
- No web-client change (intentional — gateway seed covers web's `?session_id=`).
- No config.yaml / schema_version change (wire + behavior only).
