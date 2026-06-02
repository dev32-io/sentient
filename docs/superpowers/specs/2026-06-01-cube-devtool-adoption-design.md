# Cube Devtool Adoption + Public Hardening — Design

**Date:** 2026-06-01
**Status:** Design approved, awaiting plan
**Predecessor:** Phase 6 Cube SDK (`docs/superpowers/specs/2026-05-14-cube-sdk-design.md`), esp32-devtool extraction (`docs/superpowers/specs/2026-05-15-esp32-devtool-design.md`)
**Public repo:** `https://github.com/dev32-io/esp32-devtool` (board+project agnostic ESP32 dev CLI + firmware companion)

## Goal

Swap sentient's in-tree `esp32/devtool/` snapshot for the public `dev32-io/esp32-devtool` repo consumed as a git submodule, retaining every devtool capability cube uses today, while using the swap as the forcing function to find and fix issues upstream so the public repo reaches production grade and stays board + project agnostic.

This is one phase: **adopt + active audit**. Adoption drives the work; a deliberate hardening pass (provider interfaces, leakage audit, prod-strip, docs) closes the public-repo-production-grade loop.

## Non-goals

- Bringing up a second physical board (agnosticism proven by audit gate, not hardware demo).
- Publishing esp32-devtool to PyPI (submodule + `uv run --script` shim is the distribution path this phase).
- Cube SDK feature work (Phase 6b/6c) — orthogonal; this phase only touches the devtool surface.
- Rewriting the cube firmware companion from scratch — it already speaks the companion's `devtool_register_verb` API.

## Context: current state

- `esp32/devtool/` in sentient is a **stale pre-polish snapshot** taken before the public repo was hardened. Since the snapshot, public `main` added `cli/elf.py` (manifest `build_artifact` field), `active_boards_dir()` + `--boards-dir`/`ESP32_DEVTOOL_BOARDS_DIR`, moved `boards/cube.yaml` → `examples/cube/cube.yaml`, dropped `cli/commands/setup.py`, and added `docs/AGENTIC-WORKFLOW.md`, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`, `NOTICE`.
- Cube firmware **already** consumes the companion via `devtool_register_verb(...)` and already expects the component at `esp32/devtool/firmware/esp32_devtool_companion` (see `esp32/cube/firmware/CMakeLists.txt` and `main/CMakeLists.txt`). The migration to the esp32-devtool dispatcher already happened; this phase points it at the public component and reclassifies verbs.
- Host CLI is wired by path: `scripts/env.sh` prepends `esp32/devtool/bin`; `esp32/cube/tests/hil/cube_dut.py` hardcodes `REPO_ROOT/esp32/devtool/bin/esp32-devtool`. Mounting the submodule at the same path keeps both working with zero edits.

## Decisions (from brainstorm)

| Dimension | Decision |
|--|--|
| Phase scope | Adopt + active audit (one phase) |
| Agnostic proof bar | Automated leakage audit gate — grep public repo for sentient/cube/project strings, zero matches outside `examples/`. Asserted, not hardware-demonstrated. |
| Cross-repo workflow | Edit-in-submodule → validate on real cube → PR to dev32-io → merge `main` → bump sentient submodule pointer. |
| Done gate | e2e HIL matrix green on real cube + audit gate + prod-strip verified + upstream docs updated. |
| Verb policy | Upstream pure primitives as companion built-ins; define generic provider interfaces for hardware-touching verbs (cube injects impl); sentient-specific verbs stay cube-side. |
| CLI distribution | git submodule at `esp32/devtool` (no PyPI). `uv run --script` shim runs from the checkout; two-way fixes via in-place submodule branch. |

## Repo topology & config homing

```
sentient/                                  esp32-devtool (dev32-io, public)
├── esp32/devtool/  ◄── git submodule ────► main @ pinned commit
│     (was: stale local snapshot)              cli/  bin/  boards/
│                                              firmware/esp32_devtool_companion/
│                                              examples/cube/  docs/
├── esp32/cube/
│   ├── devtool/boards/cube.yaml   ◄── NEW home (sentient-owned, OUTSIDE submodule)
│   └── firmware/
│       ├── CMakeLists.txt          → EXTRA_COMPONENT_DIRS += esp32/devtool/firmware
│       └── main/devtool_verbs/     → sentient-specific register_verb shim only
└── scripts/env.sh                  → export ESP32_DEVTOOL_BOARDS_DIR=.../esp32/cube/devtool/boards
                                       (PATH prepend unchanged — same submodule path)
```

The swap, concretely:
1. `git rm -r esp32/devtool` (delete stale snapshot); `git submodule add https://github.com/dev32-io/esp32-devtool esp32/devtool` pinned to public `main`. Same path → `env.sh` PATH prepend, `cube_dut.py` `DEVTOOL_BIN`, firmware `EXTRA_COMPONENT_DIRS` all keep resolving unchanged.
2. Move `cube.yaml` out of the submodule into `esp32/cube/devtool/boards/cube.yaml` (sentient-owned). Add `build_artifact: sentient_cube.elf`, sentient verb list, sentient paths.
3. `scripts/env.sh` exports `ESP32_DEVTOOL_BOARDS_DIR` → that dir. CLI's `active_boards_dir()` already honors it.
4. Nothing sentient-specific remains inside `esp32/devtool/` — precondition for the audit gate.

**Boundary rule:** the submodule tree is read-only from sentient except when authoring an upstream fix on a branch. All sentient-specific config (manifest, verbs, env) lives in the sentient tree, never in the submodule.

## Verb classification & companion split

Per the verb policy. Three buckets:

### Bucket 1 — upstream as companion built-ins (pure primitives, zero hardware dep)

| Verb | Note |
|--|--|
| `log_level` | set ESP log verbosity at runtime |
| `mark` | inject a boundary marker into the log stream |
| `restart` | `esp_restart()` |

Move into `esp32_devtool_companion`, self-register in `devtool_verb_dispatcher_init()`. Cube stops registering them.

### Bucket 2 — upstream verb + contract, cube injects impl (generic name, board-specific guts)

Follows the companion's existing provider-injection pattern (`touch_provider`, `audio_record_provider` already exist).

| Verb group | New/extended companion provider | Cube injects |
|--|--|--|
| `wifi.connect/disconnect/reconnect` | `wifi_provider` | cube WiFi stack calls |
| `ui.dump_tree` | `ui_provider` (LVGL-tree serializer hook) | cube LVGL root |
| `audio.record_rms/record_pcm/play_pcm/test_tone/dump_state` | extend `audio_provider` | cube codec/I2S |

Verb dispatch + JSON contract live upstream; cube registers a provider struct at boot. Public repo gets richer; cube files shrink to thin adapters.

**Caveat:** Bucket 2 is the real upstream design work — a provider interface must be generic enough that a non-cube board could implement it. If an interface ends up cube-shaped, it failed. The grep audit will NOT catch a *conceptually* cube-coupled interface — that needs design judgment in upstream PR review (second-consumer thought-test).

### Bucket 3 — stay cube-side `register_verb` shim (project-specific)

`sentient.status`, `sentient.force_reconnect`, `sentient.last_transcript`, `tts.cancel`, `button.toggle`, `state`

Keep calling `devtool_register_verb(...)` from `esp32/cube/firmware/main/devtool_verbs/`. The dir survives but slims to ~6 sentient files + provider-injection glue.

## Stage breakdown (Approach A: submodule-first → green baseline → incremental upstream)

Five stages. Each ends green on the **real cube** before the next. e2e HIL matrix re-run after every pointer bump. Flash discipline: edit-build-edit-build, one flash per stage gate.

### Stage 0 — Reconcile + submodule swap → green baseline
- `git rm -r esp32/devtool`; `git submodule add` public `main` at same path; pin commit.
- Re-home `cube.yaml` → `esp32/cube/devtool/boards/`; add `build_artifact`; export `ESP32_DEVTOOL_BOARDS_DIR` in `env.sh`.
- Reconcile stale-snapshot deltas: dropped `cli/commands/setup.py`, new `cli/elf.py`, `active_boards_dir()`, board.py refactor — confirm cube flows (flash, logs, cmd, screenshot, audio) still resolve.
- Verbs untouched — all still cube-local on the public dispatcher.
- **Gate:** full e2e HIL matrix green on real cube. This is the integration-issue flush point.

### Stage 1 — Upstream Bucket 1 primitives (`log_level`, `mark`, `restart`)
- One devtool PR: move into companion built-ins, self-register. Bump pointer. Remove cube copies. Matrix green.

### Stage 2 — Upstream Bucket 2 provider interfaces (wifi → ui → audio sub-slices)
- Per group: define provider interface upstream + verb dispatch; cube registers provider struct; PR + bump + matrix. Three sub-slices, each independently green.

### Stage 3 — Audit gate + prod-strip
- Add leakage-audit script to public repo CI: grep for sentient/cube/project strings outside `examples/` → zero matches.
- Verify `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n` strips companion to zero footprint on a **prod** cube build (`audit_prod_strip` passes).

### Stage 4 — Upstream docs
- Update public `docs/BOARD-MANIFEST.md` + `AGENTIC-WORKFLOW.md` + companion README with what the sentient swap taught (provider-injection examples, external-boards-dir adoption recipe).

Stage 0 is the long pole and the value moment (cube alive on public devtool). Stages 1–2 are decoupled, individually shippable upstream PRs.

## Cross-repo workflow

```
hit devtool bug during a stage
  → branch inside submodule:  cd esp32/devtool && git checkout -b fix/<x>
  → edit in place, rebuild cube, validate on real cube (no copy drift)
  → push branch to dev32-io, PR → review (agnostic check) → merge main
  → cd back to sentient root: git add esp32/devtool (bumps pointer) + commit
```

The sentient commit that bumps the pointer rides in the same logical change as the cube-side adapter that needs it. Rule: bump the pointer only to a merged `main` commit, never to an unmerged branch.

## Testing — e2e HIL matrix (real cube, no faking)

Run on the physical cube over USB, agent-driven through `esp32-devtool` against the daemon. No mocks. Per `.claude/rules/e2e-testing.md` and the cube HIL/flash discipline. The matrix is the stage gate.

| # | Case | Driver / assertion |
|--|--|--|
| H1 | boot → `session.ready` | `sentient.status` returns Ready within bound |
| H2 | toggle → uplink → transcript | inject PCM, `sentient.last_transcript` matches |
| H3 | TTS playback audible | `connector.audio.done` log + operator ear-check |
| H4 | barge-in mid-TTS | gateway log `playback.stop reason=barge-in`; cube cuts within bound |
| H5 | reconnect after gateway restart | `sentient.status` Ready → Reconnecting → Ready |
| H6 | bad-token → Error, no retry storm | status Error, kind auth, log assert |
| H7 | audio record/play verbs | `audio.record_pcm` / `audio.play_pcm` round-trip |
| H8 | every generic verb post-upstream still answers identically | `info` caps + per-verb probe |
| H9 | prod build: companion stripped to zero | `audit_prod_strip` passes |

H8 is the regression guard for Bucket-1/2 upstreaming — after each move the verb must answer identically through the public component. H9 runs at Stage 3. Existing HIL tests (`test_sentient_audio_toggle`, `test_sentient_reconnect`, `test_sentient_bad_token`, `test_audio_record`, `test_audio_play_pcm`, `test_ws_recovery`, `test_smoke`, `test_voice_loop`) seed these rows.

## Risks / mitigations

| Risk | Mitigation |
|--|--|
| Stale-snapshot reconcile hides a behavior delta (CLI diverged a lot) | Stage 0 runs the *full* matrix, not a subset — deltas surface as red rows |
| Bucket-2 provider interface ends up cube-shaped (fails agnostic intent) | upstream PR review judgment + second-consumer thought-test; grep audit can't catch this |
| Flash budget blowout on real device | flash discipline: build between edits, one flash per stage gate |
| AXP2101 PMIC fault during a run | detect boot-loop signature, halt, flag operator for physical unplug + BOOT-hold recovery — the one un-automatable escape hatch |
| Pointer-bump leaves cube building against an unmerged branch | rule: bump pointer only to a merged `main` commit |
| Submodule init friction for fresh clones | document `git submodule update --init --recursive` in sentient setup + `scripts/env.sh` guard |

## Done gate

Phase complete when:
- e2e HIL matrix (H1–H9) green on the real cube.
- Leakage audit gate passes on public repo (zero sentient/cube strings outside `examples/`).
- Prod-strip verified (`CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n` → zero footprint, `audit_prod_strip` green).
- Public repo docs updated (board-manifest, agentic-workflow, companion README).
- Submodule pinned to a merged `main` commit; sentient builds clean from a fresh `--recursive` clone.
- `bun run ci` green on the sentient side (no regression from the swap).

## Open questions

None — converged in brainstorm.

## Related artifacts

- esp32-devtool design: `docs/superpowers/specs/2026-05-15-esp32-devtool-design.md`
- esp32-devtool foundation plan: `docs/superpowers/plans/2026-05-15-esp32-devtool-foundation.md`
- Cube SDK design: `docs/superpowers/specs/2026-05-14-cube-sdk-design.md`
- Public repo board-manifest guide: `esp32/devtool/docs/BOARD-MANIFEST.md` (post-swap)
- Cube C/C++ rules: `.claude/rules/esp32/cube/clean-code.md`
- e2e + flash discipline: `.claude/rules/e2e-testing.md`, `.claude/rules/esp32/cube/flash-discipline.md`
