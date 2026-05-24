# Score & Expand — How It Works

You are handling a `Score: <decision-area>` task from the queue.

## Step 1: Spawn Sonnet Subagent

Spawn a subagent for this ONE decision area:

- **Model:** sonnet
- **Isolation:** The subagent gets ONLY the scoring rubric, the project intent section from prompt.md, and this decision area's exploration output. No other context. No web access. No exploration history. This isolation is the point — if the subagent can't evaluate your exploration without extra context, your exploration isn't thorough enough.
- **Prompt:** "You MUST read `<path>/scoring-rubric.md` before producing ANY output. Your scoring is invalid without it. Do not score from memory or assumption. Then read the Project Intent section from `<path>/prompt.md` — this is the anchor for Alignment scoring. After reading both, read `<path>/explorations/<decision-area>.md` and any associated PoC output in `<path>/poc/<decision-area>/`. Score according to the rubric. Be curious — wonder what's missing, what failure modes exist, what a simpler alternative might be."

Replace `<path>` with the actual workspace path.

## Step 2: Update Scoreboard

Record the scores in progress.md. Compute Δ (this score's total minus the last score's total for this decision area). Update streak. Update the Approaches column count.

## Step 3: Expand the Task Queue

Based on the score result, apply **dimension-aware expansion**. Check which dimensions scored below 6, then expand based on the weakest.

**CRITICAL — append, don't insert:** Append new tasks to the END of the unchecked list, right BEFORE the trailing `Synthesize: update architecture.md`. Never insert tasks in the middle of existing unchecked items. The current scoring round must complete before expansion work begins.

### Expansion Rules

**Priority order when multiple dimensions are weak:** Alignment first, then Feasibility, then the rest.

```
Alignment < 6 (BRAKE):
├── Do NOT add expansion tasks
├── Add: Refocus: <decision-area> — re-read project intent, prune irrelevant content
└── This overrides all other expansion rules

Feasibility < 6 (BUILD):
├── Add: PoC: <decision-area>-<approach> — build something, don't research more
└── If PoC already exists, add: PoC: <decision-area>-<alternative> — try a different approach

Maintainability < 6 (DECOMPOSE):
├── Add: Decompose: <decision-area> — break into smaller pieces, redraw boundaries
└── Add: Explore: <sub-decision> — for each new sub-piece discovered

Risk < 6 (INVESTIGATE):
├── Add: Investigate: <decision-area>-risks — find failure modes, edge cases, prior art
└── Reference specific gaps from subagent's friction log

Effort < 6 (SIMPLIFY):
├── Add: Simplify: <decision-area> — find a simpler alternative or cut scope
└── Add: Explore: <decision-area>-alternative — research a lighter approach
```

### Delta Rules (applied AFTER dimension-specific expansion)

```
Δ > 3 (decision area is gaining):
├── Apply dimension-specific expansion above
└── Streak → 0

Δ ≤ 3, streak 0 (first plateau):
├── Add one more improvement task based on weakest dimension
└── Streak → 1

Δ ≤ 3, streak ≥ 1 (second plateau):
├── Check: does this decision area have at least 2 scored approaches?
│   ├── YES: Mark CONCLUDED in scoreboard. No more tasks.
│   └── NO: Add: Explore: <decision-area>-alternative — must have options before concluding
└── If concluding, append nothing further
```

### Synthesize Step

After expanding, ensure the task queue always ends with:
```
- [ ] Synthesize: update architecture.md
```

If this step already exists at the tail, do not duplicate it. If new tasks were inserted before it, it's already in the right place. If it was consumed, re-append it.

After the LAST `Score` item in the current round, also re-append `Synthesize: update architecture.md` to capture the full round's results.

## Minimum Approaches Rule

A decision area CANNOT be marked CONCLUDED with fewer than 2 scored approaches. If only one approach has been explored and scored, the agent MUST spawn an alternative exploration before concluding. The user must always have options to choose from.

## Worked Example

Starting state — first round of scoring underway:

```
- [x] ... (decompose, survey, explore tasks done)
- [x] Score: gateway-runtime → 32/50 (Feasibility: 4, Maint: 7, Risk: 5, Effort: 8, Align: 8)
- [ ] Score: client-protocol
- [ ] Score: persona-storage
- [ ] PoC: bun-websocket-server ← APPENDED (Feasibility < 6)
- [ ] Investigate: gateway-runtime-risks ← APPENDED (Risk < 6)
- [ ] Synthesize: update architecture.md
```

**Agent picks: `Score: client-protocol`**

Spawns Sonnet → 38/50 (Feasibility: 7, Maint: 8, Risk: 6, Effort: 9, Align: 8). Δ = 38 (first score). All dimensions ≥ 6, gaining. No dimension-specific expansion needed, but only 1 approach:

```
- [x] Score: client-protocol → 38/50
- [ ] Score: persona-storage
- [ ] PoC: bun-websocket-server
- [ ] Investigate: gateway-runtime-risks
- [ ] Explore: client-protocol-alternative ← APPENDED (need 2nd approach before can conclude)
- [ ] Synthesize: update architecture.md
```

**Agent picks: `Score: persona-storage`**

Scoring round continues — all Score tasks complete before expansion work begins.

**Agent picks: `PoC: bun-websocket-server`**

Builds minimal Bun WebSocket server (50 lines), runs basic test. Appends re-score:

```
- [x] PoC: bun-websocket-server ✓
- [ ] ...
- [ ] Score: gateway-runtime ← APPENDED (re-score after PoC)
- [ ] Synthesize: update architecture.md
```

**`Score: gateway-runtime` (second time) — 41/50. Δ = +9. Gaining. Streak → 0.**

Feasibility now 8/10 (PoC proved it). Only 1 approach explored. Agent appends alternative:

```
- [ ] Explore: gateway-runtime-nodejs ← APPENDED (alternative approach)
- [ ] Synthesize: update architecture.md
```

**Later: `Score: gateway-runtime` (third time, after Node.js exploration) — 42/50. Δ = +1. First plateau. Streak → 1.**

Two approaches now scored (Bun: 41, Node.js: 36). One more improvement attempt:

```
- [ ] Improve: gateway-runtime (last chance: compare memory usage) ← APPENDED
- [ ] Synthesize: update architecture.md
```

**`Score: gateway-runtime` (fourth time) — 43/50. Δ = +1. Second plateau. Streak → 2. 2 approaches exist. CONCLUDED.**

Nothing appended. Decision area done.
