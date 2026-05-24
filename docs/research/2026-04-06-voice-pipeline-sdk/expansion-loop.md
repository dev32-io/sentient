# Score & Expand — How It Works

You are handling a `Score: <topic>` task from the queue.

## Step 1: Spawn Sonnet Subagent

Spawn a subagent for this ONE topic:

- **Model:** sonnet
- **Isolation:** The subagent gets ONLY the scoring rubric, the goals section from prompt.md, and this topic's exploration output. No other context. No web access. No exploration history. This isolation is the point — if the subagent can't evaluate your exploration without extra context, your exploration isn't thorough enough.
- **Prompt:** "You MUST read `offline-research/2026-04-06-voice-pipeline-sdk/scoring-rubric.md` before producing ANY output. Your scoring is invalid without it. Do not score from memory or assumption. Then read the Goals section from `offline-research/2026-04-06-voice-pipeline-sdk/prompt.md` — this is the anchor for scoring. After reading both, read `offline-research/2026-04-06-voice-pipeline-sdk/explorations/<topic>.md` and any associated PoC output in `offline-research/2026-04-06-voice-pipeline-sdk/poc/<topic>/`. Score according to the rubric. Be curious — wonder what's missing, what failure modes exist, what a simpler alternative might be."

## Step 2: Update Scoreboard

Record the scores in progress.md. Compute Δ (this score's total minus the last score's total for this topic). Update streak.

## Step 3: Expand the Task Queue

Based on the score result, check which dimensions scored below 6 and apply the dimension hint tag.

**CRITICAL — append, don't insert:** Append new tasks to the END of the unchecked list, right BEFORE the trailing `Synthesize: update synthesis.md`. Never insert tasks in the middle of existing unchecked items.

### Dimension-specific expansion

When a dimension scores below 6, apply its tagged expansion:

Plug-in Simplicity (BUILD):
+-- Add: PoC: <topic>-consumer-api -- build a minimal sketch showing a dev using this component in <50 lines with zero internal knowledge
\-- If PoC exists, add: PoC: <topic>-alt-api -- try a different API surface that's even simpler

State Completeness (BUILD):
+-- Add: PoC: <topic>-state-table -- build a formal transition table and test every reachable state for exits and timeout guards
\-- If PoC exists, add: PoC: <topic>-dead-state-hunt -- systematically test edge cases: reconnect, timeout, double-event, abort-during-transition

User Presence (RETHINK):
+-- Add: Rethink: <topic> -- identify every moment where the user could be left without feedback, propose indicator states
\-- Add: Explore: <topic>-presence-gaps -- map the timeline from user action to system response, find silent gaps

Extensibility Surface (INVESTIGATE):
+-- Add: Investigate: <topic>-extension-cost -- count files touched to add a new state, provider, or pipeline stage
\-- Reference specific extension scenarios: "add language detection stage", "swap STT provider", "add sentiment analysis side-effect"

Component Boundary Clarity (INVESTIGATE):
+-- Add: Investigate: <topic>-boundary-leaks -- find places where component A knows about component B's internals
\-- Check: do interfaces enforce isolation at compile time, or is it just convention?

Test Isolation (BUILD):
+-- Add: PoC: <topic>-test-harness -- build a sketch test suite that tests this component in complete isolation with mock inputs
\-- If PoC exists, add: PoC: <topic>-contract-test -- test the boundary contract between this component and its neighbors

**Priority when multiple dimensions are weak:** REFOCUS first (overrides all others). Then BUILD, INVESTIGATE, RETHINK.

Before adding any new topic, deduplicate against ALL topics in the scoreboard (ACTIVE and CONCLUDED).

### Delta Rules (applied AFTER dimension-specific expansion)

```
Δ > 3 (topic is gaining):
├── Apply dimension-specific expansion above
├── If topic has < 2 scored approaches, add: Explore: <topic>-alternative
└── Streak → 0

Δ ≤ 3, streak 0 (first plateau):
├── Add one more improvement task based on weakest dimension
└── Streak → 1

Δ ≤ 3, streak ≥ 1 (second plateau):
├── Check: does this topic have at least 2 scored approaches?
│   ├── YES: Mark CONCLUDED in scoreboard. No more tasks.
│   └── NO: Add: Explore: <topic>-alternative — must have options before concluding
└── If concluding, append nothing further
```

### Synthesize Step

After expanding, ensure the task queue always ends with:
```
- [ ] Synthesize: update synthesis.md
```

If this step already exists at the tail, do not duplicate it.

After the LAST `Score` item in the current round, also re-append `Synthesize: update synthesis.md`.

## Worked Example

Starting state — first round of scoring for an OAuth2 migration experiment with rubric dimensions: Migration Safety (BUILD), Backwards Compatibility (INVESTIGATE), Complexity Reduction (RETHINK), Test Coverage (BUILD), Rollback Viability (INVESTIGATE):

```
- [x] ... (scan, survey, explore tasks done)
- [x] Score: session-migration → 28/50 (MigSafe: 4, BackCompat: 7, Complex: 6, TestCov: 5, Rollback: 6)
- [ ] Score: token-format
- [ ] Score: client-sdk-updates
- [ ] PoC: session-migration-incremental ← APPENDED (MigSafe < 6, BUILD tag)
- [ ] PoC: session-migration-test-harness ← APPENDED (TestCov < 6, BUILD tag)
- [ ] Synthesize: update synthesis.md
```

**Agent picks: `Score: token-format`**

Spawns Sonnet → 35/50 (MigSafe: 8, BackCompat: 5, Complex: 7, TestCov: 8, Rollback: 7). Δ = 35 (first score, gaining). BackCompat < 6 (INVESTIGATE):

```
- [x] Score: token-format → 35/50
- [ ] Score: client-sdk-updates
- [ ] PoC: session-migration-incremental
- [ ] PoC: session-migration-test-harness
- [ ] Investigate: token-format-compat-risks ← APPENDED
- [ ] Synthesize: update synthesis.md
```

**Later: `Score: session-migration` (second time, after PoC) — 40/50. Δ = +12. Gaining.**

Only 1 approach explored. Agent appends alternative:

```
- [ ] Explore: session-migration-alternative ← APPENDED (need 2nd approach)
- [ ] Synthesize: update synthesis.md
```

**`Score: session-migration` (third time) — 41/50. Δ = +1. First plateau. Streak → 1.**

Two approaches now scored (incremental: 40, alternative: 36). One more try:

```
- [ ] Improve: session-migration (weakest: MigSafe) ← APPENDED
- [ ] Synthesize: update synthesis.md
```

**`Score: session-migration` (fourth time) — 42/50. Δ = +1. Second plateau. Streak → 2. 2 approaches exist. CONCLUDED.**

Nothing appended. Topic done.
