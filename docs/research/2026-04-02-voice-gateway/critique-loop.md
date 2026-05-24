# Phase 6: Critique & Expand Loop

Do NOT proceed without reading this file in full. Every instruction here is load-bearing.

## Overview

You have completed the initial research (Phases 1-5). Now you enter an iterative loop: score your work, find what's weak, expand into new territory, and keep going until every topic has plateaued — or you run out of iterations.

## The Loop

Repeat the following cycle:

### 6a. Score — Spawn Sonnet Subagents

For each ACTIVE topic in progress.md, spawn a subagent:

- **Model:** sonnet
- **Isolation:** The subagent gets ONLY the scoring rubric and the topic's output. No other context. No web access. No research history. This isolation is the point — if the subagent can't understand your findings without extra context, your findings aren't good enough.
- **Prompt:** "You MUST read `<path>/scoring-rubric.md` before producing ANY output. Your scoring is invalid without it. Do not score from memory or assumption. After reading the rubric, read `<path>/findings/<topic>.md` and score it according to the rubric. Be curious — wonder what's missing, what doesn't add up, what you'd want to know more about."

Replace `<path>` with the actual workspace path. For PoC topics, point the subagent at whatever the topic produced (code, plans, diagrams, READMEs in `poc/<topic>/`).

Spawn subagents in parallel where possible — they are independent.

### 6b. Update Scoreboard

Collect scores from all subagents. For each topic:

1. Record the new scores in the progress.md scoreboard
2. Compute Δ (this cycle's total minus last cycle's total)
3. Update streak:
   - If Δ ≤ 1: increment streak by 1
   - If Δ > 1: reset streak to 0
4. If streak reaches 2: mark topic as **CONCLUDED**

### 6c. Plan Next Actions

Look at ACTIVE topics only. For each:

- Read the subagent's friction log and "What's Missing" section
- Decide what to do next: close gaps, research deeper, add new topics
- Before adding any new topic, deduplicate against ALL topics in progress.md (both ACTIVE and CONCLUDED). If it substantially overlaps with an existing topic, don't add it.
- New topics enter as ACTIVE with no prior scores.

Research isn't only reading. When a topic would benefit from *making something* — you should definitely do it. This includes:
- Building a prototype or proof-of-concept script
- Drafting an architecture or system design
- Sketching a visual mockup, diagram, or flowchart
- Writing a plan that stress-tests an idea by trying to build it

Create a folder in `poc/` and add it as a topic in progress.md. Scored the same way.

### 6d. Execute

Research, build, or explore ACTIVE topics based on your plan from 6c. Write output to `findings/` (or `poc/` for PoC topics). Update `sources.md` with any new sources.

### 6e. Re-synthesize

Update these files to reflect everything you now know:
- `connections.md` — cross-topic patterns and insights
- `contradictions.md` — where sources disagree
- `gaps.md` — what's still weak
- `README.md` — TLDR summary with navigation

Log the cycle in progress.md under the Cycle Log section.

### Termination

- **All topics CONCLUDED →** Output the completion promise and stop.
- **Max iterations reached →** Do a final re-synthesis, output the completion promise, and stop.
- **Otherwise →** Loop back to 6a.

CRITICAL: When stopping, you MUST end with a plain text message containing `<promise>ALL PHASES COMPLETE</promise>`. Do NOT end on a tool call. The loop that runs you detects completion by scanning your text output — if you end on a file write without this text, the loop will keep re-invoking you.

## Topic Lifecycle

Two states only:

- **ACTIVE** — scored each cycle, researched if gaining
- **CONCLUDED** — Δ ≤ 1 for 2 consecutive cycles. Permanent. No further research.

There is no parent/child distinction. Sub-topics are just topics. All topics live as rows in the progress.md scoreboard.

## Workspace Evolution

You own this workspace. Organize it as the research demands:
- Add new topic files in `topics/` and findings in `findings/`
- Create `poc/` subfolders for prototyping work
- Split, merge, or reorganize files when it makes the research clearer
- Every new topic gets a row in the progress.md scoreboard
