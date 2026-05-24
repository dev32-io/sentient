# Sentient — Open Source Release

**Date:** 2026-05-24
**Author:** Kevin Ye
**Status:** Approved spec, ready for implementation plan

---

## 1. Why this is going public

Sentient was built for our household — a real-time voice assistant on a Raspberry Pi 5 that the whole family can talk to. The system is now stable enough that other people might want to run something similar in their own homes, and the architecture (streaming STT, streaming TTS, barge-in arbitration, dual-Pi5 split, Hermes-backed agent loop) is the kind of thing that's easier to learn from a working repository than from documentation alone.

Moving from a private GitLab to a public GitHub repository so that contributors can find it, file issues, fork it, or pull design ideas out of it. GitLab will be archived read-only after the cutover; all future development happens on GitHub.

## 2. What gets published

A single repository at `github.com/<owner>/sentient` seeded with a fresh first commit ("Initial public release"). No prior history carried forward.

**Included from the current `develop` tree:**

- `gateway/` — Bun/TypeScript voice gateway + Preact webui
- `capabilityServices/` — STTService (Silero VAD + Smart-Turn v3 + SenseVoice-Small)
- `shared/` — protocol, web-sdk, config, wizard, audio-prefs, tls, testing workspaces
- `sentient-auth/` — shared-token auth CLI + library
- `deploy/` — docker, macos, pi compose files
- `esp32/cube/` — firmware (Phase 5.5 state) + scripts + devtool
- `profiles/` — only an `example/` template, no real household data
- `docs/research/` — research write-ups (markdown only, no PoC scratch trees)
- `pocs/` — design experiments worth showing
- `scripts/` — shell helpers
- `agents/docs/` — topic details + learnings (useful context for contributors)
- `.claude/rules/` — rules that auto-load in Claude Code
- Top-level: `README.md`, `CLAUDE.md`, `package.json`, `bun.lock`, `biome.json`, `lefthook.yml`, `tsconfig.base.json`, `.gitignore`

**Stripped from the export:**

- `docs/research/*/poc/*/venv/` and `docs/research/*/poc/*/node_modules/` — bundled Python venvs and Node deps (~40 MB of regeneratable artifacts that bloat clones)
- `.worktrees/` and `.claude/worktrees/` — local-only scratch
- `.playwright-mcp/` — local browser session artifacts
- `.gitlab-ci.yml` — replaced by `.github/workflows/`
- `pipeline-diagram.png` at repo root — superseded by `docs/diagrams/`
- `qa/*/sessions/`, `qa/*/.playwright/` — per-run QA artifacts
- `profiles/family/` and any other directory with real household names — replaced by `profiles/example/`
- Stray internal handover docs that reference personal context (spot check before publish)
- `graphify-out/` if present in working tree

## 3. Pre-flight on GitLab

Done on the GitLab side before exporting:

1. Merge `feature/esp32-cube-v2-rescope` into `develop` (the only branch with unmerged work; the other 35 feature branches are all 0 ahead of `develop`).
2. Decide the fate of `esp32/devtool/uv.lock` — commit it for reproducibility, or add to `.gitignore`. Recommend commit.
3. Optional: delete the 35 merged feature branches on GitLab for cleanup.
4. Final secrets scan with `gitleaks` against the working tree (sample scan came up clean, but a broader rule set is worth one final pass before export).

## 4. Licensing

License chosen: **MIT** at repo root.

Three audits ran across npm/Bun, Python + ML models, and ESP32 firmware deps. No GPL/AGPL/SSPL/non-commercial dependencies anywhere. MIT compatibility is clean across the board, with attribution requirements for permissive deps.

**Files to add:**

- `LICENSE` — standard MIT, copyright the project owner
- `THIRD_PARTY_NOTICES.md` at repo root — attribution for:
  - **Apache-2.0:** dockerode, openai, transformers, sherpa-onnx, huggingface_hub, @jitsi/rnnoise-wasm wrapper
  - **BSD-3-Clause:** RNNoise C source, libopus (bundled in wasm decoders), websockets, soundfile, psutil, opuslib, partial numpy
  - **BSD-2-Clause:** Smart-Turn v3.2 ONNX weights (Pipecat)
  - **MPL-2.0:** DOMPurify (unmodified consumption from npm; no patch fork)
  - **Custom (FunASR Model License v1.1, Alibaba):** SenseVoice-Small ONNX weights — commercial use permitted, requires attribution + retain model name + has a non-standard termination clause. Not OSI-approved. Worth flagging in README + NOTICE so downstream redistributors know.
- `esp32/cube/firmware/THIRD_PARTY_NOTICES.md` — separate notices for the firmware tree:
  - xiaozhi-esp32 vendored at SHA `b72945a` (MIT)
  - xiaozhi-fonts (MIT wrapper) bundling Noto + Alibaba PuHui (**SIL OFL 1.1**)
  - ESP-IDF + all `espressif/*` managed components (Apache-2.0)
  - LVGL 9.x (MIT)
  - esp-ml307, esp-wifi-connect, esp_lcd_nv3023, uart-eth-modem (Apache-2.0)
  - gifdec (Public Domain)
- SPDX-License-Identifier headers on first-party firmware files in `esp32/cube/firmware/components/agent_console/` and `.../net_logger/`. New files should also carry the header going forward.
- Post-build sweep of `esp32/cube/firmware/managed_components/*/idf_component.yml` for any `license:` field that isn't MIT / Apache-2.0 / BSD / OFL / public-domain. None expected, but verify.

**README disclosure:** SenseVoice-Small model weights ship under a separate model license. Linked in `THIRD_PARTY_NOTICES.md`. Models download at Docker build time via `scripts/download_models.py` rather than vendored in git, so redistribution surface is limited to built Docker images.

## 5. Repository restructure

The current `README.md` reads as internal-team documentation. Rewrite for a first-time external reader.

**Files to add or rewrite:**

- `README.md` — rewritten with the structure in §6
- `ARCHITECTURE.md` — the technical deep-dive that currently lives in the middle of the README. Pipeline stages, cycle lifecycle, AttentionGate, ConversationMirror, barge-in flow, Hermes dial contract.
- `ROADMAP.md` — what's done, what's in progress, what's planned
- `CONTRIBUTING.md` — how to file issues, send PRs, set up a dev environment, what the test gates look like
- `CODE_OF_CONDUCT.md` — standard contributor covenant
- `.github/workflows/ci.yml` — port the relevant pieces of `.gitlab-ci.yml` (lint, typecheck, unit tests, build verification)
- `.github/ISSUE_TEMPLATE/bug_report.md` and `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/diagrams/` — committed mermaid sources + their rendered SVGs (so people who can't render mermaid still see the picture)
- `esp32/STATUS.md`, `android/STATUS.md`, `ios/STATUS.md` — one-page each describing what the directory will hold, current state, and roadmap link

**Files to rename or reshape:**

- `profiles/family/` → `profiles/example/` (or delete entirely if nothing useful remains after sanitizing). The real `family` profiles live outside the repo at `~/.sentient/profiles/` going forward.

## 6. README shape

The opening should let a stranger figure out what Sentient is, what hardware it needs, and how to boot it within the first scroll.

Suggested structure:

1. **One-paragraph what** — what Sentient is, what hardware it runs on, what the user experience looks like (toggle-to-talk web client, ESP32 cube, eventual mobile).
2. **Pipeline diagram** — the mermaid figure (mic → VAD → streaming STT → cycle dispatch → Hermes → streaming TTS → speaker, with the barge-in path).
3. **Status** — gateway runs in production at one household, ESP32 cube in active development, Android and iOS planned.
4. **Quick start (local dev)** — `bun install`, set two env vars (`OPENROUTER_API_KEY`, `FISH_AUDIO_API_KEY`), `docker compose up`, open `https://localhost:8888`.
5. **Hardware** — dual Raspberry Pi 5 for production install, single dev box (Mac/Linux) for local development.
6. **Architecture overview** — short version, with a link to `ARCHITECTURE.md` for the deep-dive.
7. **Latency** — measured numbers for end-to-end p50/p90, barge-in detect-to-cancel, TTS first-byte. Placeholder until measurement protocol runs.
8. **Demo** — 30–60 second screen capture of a conversation including a barge-in. Placeholder until recorded.
9. **How it's built** — short paragraph noting human-authored with Claude Code pair, `Co-Authored-By` trailers on assisted commits, standard human-in-the-loop review discipline. Audit trail via `git log --grep "Co-Authored-By: Claude"`.
10. **License + attribution** — MIT, pointer to `THIRD_PARTY_NOTICES.md`.
11. **Contributing** — pointer to `CONTRIBUTING.md`.

## 7. Migration mechanics

The migration is one push, not a long-running mirror.

1. From a clean checkout of the post-merge `develop` tip, build a sanitized export tree using `rsync` with the strip list from §2. Sanity-check the output (`du -sh`, `find . -name venv -o -name node_modules`) before proceeding.
2. `cd /Users/kevinye/Development/github-repo/sentient` (empty repo, `.git/` already initialized).
3. `git checkout -b develop`.
4. `rsync -a --delete <sanitized-export>/ ./` (with `.git/` excluded so the empty repo's `.git/` survives).
5. Add `LICENSE`, `THIRD_PARTY_NOTICES.md`, `esp32/cube/firmware/THIRD_PARTY_NOTICES.md`, the README rewrite, `ARCHITECTURE.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/` templates, and `docs/diagrams/`.
6. `git add -A`.
7. `git commit -m "Initial public release"` (no `Co-Authored-By` here — this commit is the snapshot, not the work).
8. `git branch main` so both `develop` and `main` start at the same commit. `develop` stays checked out (the active dev branch).
9. Create the GitHub repository (public, no auto-generated README/LICENSE/.gitignore — we ship our own).
10. `git remote add origin git@github.com:<owner>/sentient.git`.
11. `git push -u origin develop main`.
12. On GitHub: set `develop` as the default branch. Enable branch protection on both `develop` and `main` (require PR review, require CI status checks).
13. Archive the GitLab repository read-only. Add a one-line note in the GitLab repo description pointing to the GitHub URL.
14. On the local machine: in the original GitLab clone, rename the GitLab remote to `archive` and add the GitHub one as `origin`. Going forward all branches push to GitHub.

## 8. Going-forward discipline

After the cutover, the security posture tightens because anything pushed is public the moment it lands.

- **Pre-commit secret scan:** add `gitleaks` (or `detect-secrets`) to `lefthook.yml` so accidental key commits get blocked locally before they ever reach `git push`.
- **PR-only workflow on `develop`:** no direct pushes. Branch protection enforces this on GitHub.
- **Profiles with real data live outside the repo** at `~/.sentient/profiles/`. The in-repo `profiles/example/` is the only thing that ships.
- **`.worktrees/` is scratch only.** Never commit anything from there; never let a worktree path leak into a tracked file.
- **License header policy:** new first-party source files in the firmware tree carry `// SPDX-License-Identifier: MIT` at the top. TypeScript first-party files are implicitly MIT under the repo `LICENSE`; no per-file header needed.

## 9. Post-publish backlog

These don't block the initial release but should land within the first few weeks. Each is its own plan once the initial release ships.

- **Latency measurement** — run 50 conversational turns over WiFi and over wired LAN, capture timestamps at mic-capture → VAD → STT first-partial → STT final → LLM first-token → TTS first-byte → speaker first-PCM. Tabulate p50/p90/p99 per leg and end-to-end. Commit to `docs/latency.md` and update README placeholders.
- **Demo capture** — 30–60 second screen recording of a conversation including a barge-in mid-response. Render as a looping mp4 or gif under 5 MB. Reference from the README.
- **Architecture diagram render** — render the mermaid in `docs/diagrams/architecture.md` to `docs/diagrams/architecture.svg` so non-mermaid renderers still see the picture.
- **Fresh-clone smoke test** — clone the public repo onto a different machine (or a fresh VM), follow the README quick-start verbatim, confirm the stack boots. Fix any documentation gap the test surfaces.
- **`good first issue` seed** — open 5–10 issues that an external contributor could realistically pick up without deep context. Examples: improve a unit test, add a config validation message, document a config knob, port a small utility.
- **CONTRIBUTING.md fleshing** — once the first external PR or issue arrives, refine `CONTRIBUTING.md` based on the questions asked.

## 10. Out of scope

- Renaming or reshaping internal APIs to make them feel "more public." The current shape works for our use; if a contributor finds an API confusing, that's a follow-up issue.
- Pre-built binary releases / GitHub Releases — the install path is `docker compose build` from source. Pre-built images can come later if there's demand.
- Translations / i18n.
- Hosted demo. The system is meant to run on your own hardware.
