# Native Stack Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the gateway out of Docker into the native host-orchestrator role it already plays in code, so `delegateTask` works, and then execute the 2.0 E2E matrix it unblocks.

**Architecture:** The gateway becomes a compiled native binary supervised by launchd. It supervises addons through one registry and one driver interface with two backends — `docker` (MCPs, searxng, egress-proxy) and a new `native` backend (whisper-stt, local-tts). Hermes is not a managed service: it is a one-shot exec, which is the whole reason the gateway must share a filesystem with it. Code lives root-owned under `/opt/sentient/<version>/`; mutable state stays user-owned under `~/.sentient/`.

**Tech Stack:** Bun 1.3.11 (`bun build --compile`), TypeScript strict, zod, dockerode, launchd, Python 3.11 (local-tts) / 3.14 (whisper-stt) with vendored wheels, Playwright MCP (web E2E), Maestro (native E2E).

**Spec:** `docs/superpowers/specs/2026-07-29-native-stack-migration-design.md` — read §1–§11 before starting any task.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Branch:** `feature/native-orchestrator`. Never push to `main` or `develop`. Commit format `type(scope): description`, one logical change per commit.
- **Commit by explicit pathspec** — `git commit -- <paths>`, naming only your files. Never `git add -A`, `git add .`, `git commit -a`, or a bare `git commit` after staging. Agents in a wave share one git **index**, not just a working tree: a sibling blocked behind a red hook may have files staged, and a non-pathspec commit silently sweeps them into yours. This happened twice in the previous plan. Run `git status --short` before every commit.
- **`git commit -- <dir>` does NOT commit a new file** — the pathspec form commits working-tree content of **tracked** paths only, so a file you just created inside that directory is silently left behind and the commit does not build in isolation. `git add <newfile>` first, then commit by pathspec. Found in task 9f, whose store migration shipped one commit without the migration module it depended on. Every task that creates a file is exposed to this: after committing, `git show --stat HEAD` and confirm each new file is listed.
- **Never** run `git stash`, `git checkout --`, `git restore`, or `git reset`. If the pre-commit hook fails, fix the cause — never `--no-verify`. The hook runs repo-wide lint + typecheck against the **working tree**, so a sibling mid-edit can block you: retry, don't bypass.
- **Docker addon ports bind to `127.0.0.1` only.** `0.0.0.0` is docker's default and would expose every MCP to the LAN. Any `ports:` entry without a `127.0.0.1` prefix is a defect.
- **Code is root-owned and immutable; state is user-owned and mutable.** Nothing executable lives under `$HOME`. `/opt/sentient/**` is `root:wheel 0755`; `~/.sentient/**` is user-owned with `secrets/` at `0600`.
- **Nothing fetches at deploy time.** Bun deps are embedded by `--compile`; Python deps install from vendored wheels via `pip install --no-index --find-links=`. No npm or PyPI access on the mini.
- **Per-service pinned interpreters carry forward verbatim:** `local-tts` → Python **3.11** (mlx-audio ships no 3.14 wheels), `whisper-stt` → Python **3.14**. Do not "upgrade" these.
- **Hermes is never a managed service.** It has no lifecycle, port, or health check. It is `hermes -p <userId> -z <prompt>`, invoked and exited.
- **`hermes-runner` sets its subprocess `cwd` to `resolveProfileDir(userId)` and the profile must already exist.** `profile-store`, `renderInnerProfile` and `renderConfigsForExistingUsers` therefore **stay**. Only the supervisord *daemon* machinery is deleted.
- **Read before delete.** No config key, module, or rule is removed without first grepping for a live reader. Deleting on suspicion is how a working feature dies silently.
- **Config:** every tunable lives in YAML with an inline comment and valid range. No magic numbers in source. Never add keys under the legacy `cerebrum:` block.
- **Logging:** tagged logger per file reflecting its hierarchy; no bare `console.*`. Log every state change, boundary decision and fallback with a `reason`. Truncate previews to ≤120 chars. Never log secrets or chat content.
- **Test bar (strict).** A test earns its place ONLY by pinning a wire/protocol contract at a process boundary, an FSM/invariant, a security boundary, or by being an `@live` flow. Do NOT test pure utilities, DI plumbing, types, or constants. Borderline tests get deleted, not kept.
- **E2E is agent-owned and serialized** — one gateway owns `:8888`, one device per Maestro batch. Local stack only, never prod (`mini0.lan` / `sentient.dev32.io` are observational-only).
- **Delete stale references as you go.** Fixing code without fixing its now-wrong comment is an incomplete task.

---

## Execution Resilience (binding — read before starting any task)

Long agent runs get killed mid-flight by usage limits. Measured on the previous plan: **loss was exactly proportional to time-since-last-commit.** One kill kept everything because the implementer had committed; another lost 356k tokens of work because two agents were ~17 minutes in with a clean tree. These rules shrink the blast radius rather than pretending kills won't happen.

- **Commit after EVERY red→green cycle, not at task end.** The moment a test goes green and the gate passes, commit. Worst case a kill then costs one cycle instead of a whole task. Commit messages may be small and incremental — the branch is squashed at merge.
- **Every task starts with a STATE PROBE.** Before doing any work, determine what is already done by inspecting the repo — not by assuming you are starting fresh:
  ```bash
  git log --oneline -15
  git status --short
  # then the task's own markers, e.g.:
  ls gateway/src/system-orchestrator/native-driver.ts 2>/dev/null && echo "step 9 done"
  ```
  Report which step you are resuming at. A resumed agent re-derives position from the repo, never from lost context.
- **Append to your report file after each commit**, not once at the end. A kill that preserves commits but loses the reasoning still costs the reviewer their context.
- **Append one line to `.superpowers/sdd/progress.md` after each commit:** `<task>: <step> complete (<sha>)`. The ledger is the recovery map; a per-task granularity is too coarse to resume mid-task.
- **Never leave the tree dirty at a natural pause.** If a cycle is green, commit it before starting the next.
- **Idempotence:** re-running a completed step must be safe. Write steps so a resumed agent that redoes one step loses nothing.

Cost, stated honestly: the pre-commit hook runs repo-wide lint + typecheck (~5s), so a 17-step task pays ~85s in hook time. That is cheap against re-running a killed task.

---

## File Ownership & Wave Structure

Parallelism is bounded by **file ownership**, not task count. In the previous plan two agents both needed `session-runtime.ts`; the collision cost ~20 minutes of blocked commits and blurred attribution. Wave boundaries below are drawn from actual file sets, verified against each task body.

**`gateway/config.yaml` has exactly one owner per wave** — it is the single most contended file in this migration.

| Wave | Task | Owns | Model |
|---|---|---|---|
| **1** | T1 native driver | `gateway/src/system-orchestrator/**`, `shared/config/src/schemas/*` (managed-services schema) | opus |
| **1** | T2 compiled binary + build script | `scripts/build-gateway.sh`, gateway asset-path resolution | opus |
| **1** | T3 Python lockfiles + vendored wheels | `deploy/mac-prod/native/**`, per-service `requirements.lock`, wheel build script | sonnet |
| **2** | T4 native cutover | `gateway/config.yaml`, `deploy/**` compose + launchd plist, delete `gateway/Dockerfile` | opus |
| **2** | T5 installer rewrite | `deploy/mac-prod/setup-prod.py` + install helpers | opus |
| **3** | T6 deletions + config audit | `gateway/src/admin/**`, `gateway/src/bootstrap/**`, `session-router.ts`, `gateway/config.yaml` | opus |
| **3** | T7 docs & rules sweep | `.claude/rules/**`, `CLAUDE.md`, `deploy/README.md`, `agents/docs/**` | sonnet |
| **4** | T8 migration E2E (§9.3) | `qa/**` — runs the stack | sonnet |
| **5** | T9 web matrix (§9.2) | `qa/web/**`, `agents/docs/testing-knowledge.md` | sonnet |
| **5** | T10 native matrix (§9.2) | `qa/mobile/**` | sonnet |
| **6** | T11 operator handoff (§9.4) | `docs/` handoff checklist | sonnet |

**Dependency edges:** T4 needs T1+T2+T3. T5 needs T4's layout (writes against it; can start once T4's layout is fixed). T6 needs T4 (the cutover removes the container that justified the daemon). T7 documents reality, so it follows the code. T8 needs T4+T5. T9/T10 need T8 green.

**Why T9 and T10 are the same wave but still serialized:** both need the one local stack. They are listed together because they share a wave *boundary*, not because they run concurrently. Run web to green, then native.

**Wave 3 conflict note:** T6 and T7 both touch documentation-adjacent surfaces, but T6 owns *code comments in files it deletes* while T7 owns `.claude/rules/**` and `agents/docs/**`. No file overlap. T6 owns `gateway/config.yaml` in this wave; T4 owned it in wave 2 and has landed by then.

---

## Task Bodies

One file per task in this directory. Each is independently testable and ends in a commit.

| File | Task |
|---|---|
| `task-1-native-driver.md` | The `native` launch type in the orchestrator |
| `task-2-compiled-binary.md` | `bun build --compile` + asset resolution + build script |
| `task-3-python-wheels.md` | Locked requirements + vendored wheels, offline install |
| `task-4-native-cutover.md` | launchd, `/opt` layout, loopback publishing, drop the gateway container |
| `task-5-installer.md` | `setup-prod.py` → installer with health-gate + auto-rollback |
| `task-6-deletions-and-config-audit.md` | Supervisord fleet, port store, ACP router, stale config keys |
| `task-7-docs-and-rules.md` | Rules/docs sweep to match the shipped reality |
| `task-8-e2e-migration.md` | §9.3 migration cases |
| `task-9-e2e-web.md` | §9.2 web matrix |
| `task-10-e2e-native.md` | §9.2 native matrix |
| `task-11-operator-handoff.md` | §9.4 handoff checklist — the final artifact |
