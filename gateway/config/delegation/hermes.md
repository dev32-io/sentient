---
allowed_tools:
  - "*"
network: full
confirm_class: confirm
enabled: true
---

# Hermes — delegated general-purpose agent

Static delegation envelope for `delegateTask(agent: "hermes", taskPrompt)`
(native-orchestrator spec §2.3, §5.4). Loaded by `delegation-guard.ts`'s
`loadDelegationEnvelope` — the filename (`hermes`, sans extension) is the
`agent` key.

This is the **reference template for the future Skill security layer**
(spec §2.3): same frontmatter shape (`allowed_tools`, `network`,
`confirm_class`), same loader pattern (YAML frontmatter + markdown body,
one file per capability-holder), different consumer. A future Skill
sandbox reuses this exact envelope shape rather than inventing a new one.

## Fields

- `allowed_tools` — tool names the delegated worker may use once it
  re-enters our gateway MCP host (the free mitigation hook noted in
  spec §2.3: pointing a delegated worker's own tools at *our* MCP host
  re-enters our L3 PDP). `["*"]` here is informational only in v1 — not
  yet enforced against Hermes's own internal tool calls (accepted risk,
  spec §2.3).
- `network` — coarse network capability. Hermes is a broadly-capable local
  agent by design (its own tool loop reaches the internet, home services,
  etc.), so this is `full` rather than pretending otherwise.
- `confirm_class` — what a `high`-tier classified `taskPrompt` resolves to
  for this agent: `confirm` (default here) or `deny`. A future, less
  trusted agent can set `deny` to hard-block high-risk prompts instead of
  surfacing a confirmation.
- `enabled` — operator kill switch. Flip to `false` to disable delegation
  to this agent without deleting the file (an agent absent from the
  frontmatter dir entirely is denied the same way, per
  `delegation-guard.ts`'s `evaluate`).

## What this file does NOT do

The static envelope above is coarse and does not (cannot) constrain the
free-form `taskPrompt` an LLM writes. Real per-invocation safety is the
dynamic classifier (`prompt-classifier.ts`, reusing the injection scanner
+ risk accumulator) — see `delegation-guard.ts`'s module header for the
full allow/confirm/deny decision table.
