# Gateway TODO

## MCP / sandbox network hardening (deferred from 2026-04-29)

Today the per-task hermes docker-backend container is pinned to the
`sentient-internal` network and outbound traffic is routed through the
`egress-proxy` (tinyproxy) sidecar via `HTTP_PROXY` / `HTTPS_PROXY` env
vars. This works for HTTP/HTTPS clients (pip, npm, curl, requests) but
has a known gap: **raw TCP / UDP / non-HTTP protocols bypass the proxy.**
A determined script could open a socket to any host reachable on the
docker bridge.

For now, blast radius is acceptable: `sentient-internal` has
`internal: true`, so the task container has no default route to the LAN
or internet. Raw-TCP attempts to external hosts simply fail with
"Network is unreachable." But raw-TCP to **other containers on
`sentient-internal`** (gateway, sentient-hermes, the egress-proxy,
and any other active neighboring containers) **does** work — that's a lateral
attack surface inside the trust boundary.

Hardening work to do later:

- [ ] Build a dedicated `sentient-task` docker network for the task
      containers. Keep it `internal: true`. Attach `egress-proxy` to it
      as the only neighbor (no other Sentient services on it). Pin the
      `docker_network` config to that network. Result: task containers
      can reach **only** the egress-proxy and nothing else inside our
      stack.
- [ ] Add iptables egress rules on the `egress-proxy` container to
      enforce per-destination allowlists (Spotify, OpenAI, PyPI, etc.)
      instead of the current "anything tinyproxy will CONNECT to."
- [ ] Investigate rootless docker / sysbox runtime as the sandbox host
      to shrink the docker-socket-mount blast radius (currently
      `/var/run/docker.sock` mounted into `sentient-hermes` is
      host-root-equivalent if the worker is compromised).
- [ ] Pin a Sentient-built sandbox image (`ghcr.io/sentient/agent-sandbox:<tag>`)
      instead of the upstream `nikolaik/python-nodejs:python3.11-nodejs20`,
      so we control the toolchain + base packages and can audit what
      ships.

Track progress against the threat model in
`agents/docs/gateway/mcp-deployment-details.md`.

## Skill marketplace + agent-driven skill installation (deferred from 2026-04-30)

Today, hermes skills are per-user files under
`~/.sentient/gateway/data/<userId>/profiles/<userId>/skills/` — added by
hand-editing files on disk. Two related gaps:

1. **No sharing.** A skill written by Mom for "school morning routine"
   can't be discovered or copied by Dad without manual `cp`, even
   though they're in the same household. There's no in-product surface
   to browse, preview, or install skills.
2. **No agent-driven creation.** When a user says "remember that we
   start the dishwasher every night at 9pm and give me a heads-up at
   8:55," the agent has to talk the user through editing a markdown
   file. That's the wrong shape — the agent should be able to write the
   skill itself.

Build for both, in this order:

- [ ] **Skill upload endpoint** — `POST /api/v1/skills/{name}` (auth'd
      with the user's own bearer; writes into the calling user's
      skills dir). Used by hermes via a new gateway-MCP tool
      (`save_skill`) so the agent can author skills mid-conversation.
      Validate: filename slug, markdown body size cap, skill schema
      (frontmatter, body sections). Trigger profile-apply on write so
      the new skill is loaded into the worker without a manual restart.
- [ ] **Skill marketplace pane** — new tab under Settings (or a
      separate "Skills" surface) with three sections: *My skills*
      (CRUD: edit/delete/duplicate), *Family shared* (skills other
      household members have published), *Sentient builtin* (curated
      pack — see below). Each card: title, body preview, install button
      (writes a copy into the current user's dir). Browser fetch via a
      new `GET /api/v1/skills/marketplace` endpoint.
- [ ] **Per-household sharing primitive** — a "publish" toggle on each
      skill card flips it into a household-readable slot (separate dir
      / DB column). Membership is already tracked by the existing
      Members admin UI. Decide: file-on-disk vs sqlite (state.db). Lean
      toward state.db so we get a single source of truth + audit log.
- [ ] **Sentient built-in skill pack** — a ship-with-the-image set of
      skills that every new user starts with (timer, reminder, "quick
      facts," voice-tier MCP coaching). Decision: where do they live
      and how do they auto-update?
        - Bundled into `gateway/skills/builtin/` and rendered into each
          user's skills dir on apply (override-if-newer)?
        - Or a remote manifest the gateway pulls from a GitHub
          release on a daily cron?
        - Auto-update on container start vs explicit "Update built-ins"
          button?
      The first option (bundle + override-on-newer-checksum) is the
      simplest and matches how SOUL.md template overrides work today.
      Revisit when the marketplace ships if family demand for "fresh
      skills without pulling a new image" justifies the cron path.

Watch for: agent-written skills are user-content and must NOT bypass
the prompt-injection scanner (see `gateway/src/security/`). The
`save_skill` tool result the agent sees should be `{ok: true,
filename}` — never echo back the body text the agent just wrote, that's
a self-priming loop.

## Settings: Hermes-knob coverage gaps (deferred 2026-05-05)

Beyond the v1 Memory tab, these Hermes knobs are still hidden behind hard-coded defaults. Add when refinement bandwidth allows.

- [ ] **Advanced tab — agent loop knobs**: `agent.max_turns` (slider, today hard-coded 6), `agent.reasoning_effort` (segmented minimal/low/med/high/xhigh, today hard-coded medium), `compression.target_ratio` (default 0.20), `compression.protect_last_n` (default 20).
- [ ] **Tools tab — built-in toolsets card**: toggle list for Hermes built-ins (memory, todo, clarify, skills, session_search, messaging, web, browser, terminal, file, vision, image_gen, tts, cronjob). Today `profile.tools.toolsets` exists but no UI.
- [ ] **Display tab (new, User group, no restart)**: `display.tool_progress` (off/new/all/verbose), `display.show_reasoning`, `display.streaming`, `display.interim_assistant_messages`, `display.background_process_notifications`, `display.bell_on_complete`.
- [ ] **Safety tab (new, Soul group, restart)**: `approvals.mode` (smart/always/never), `approvals.timeout_seconds`, `approvals.fail_closed`, `privacy.redact_pii`, `security.tirith.enabled`.
- [ ] **Skills tab (new, Soul group, read-only v1)**: list `profiles/<user>/skills/<name>/DESCRIPTION.md` with preview. v2 = on/off filter (needs gateway-side filter, not native config).
- [ ] **Activity tab (new, large)**: read-only browsers for `sessions/`, `plans/`, `cron/` (with run/pause/remove via Hermes' `cronjob` tool API), `workspace/`. Own design pass.
- [ ] **Memory tab v2**: char-limit ranges currently anchored to Hermes upstream defaults (memory 2200 / user 1375). If we ever want richer memory (e.g. raise caps for power users) verify Hermes' agent-side pruning still behaves at higher limits before exposing.

## Renderer fix: memory block missing (found 2026-05-05)

`gateway/templates/profile/hermes-config.yaml.tmpl` writes no `memory:` block. Hermes silently uses upstream defaults (`memory_char_limit: 2200`, `user_char_limit: 1375`). Old `profiles/bob/config.yaml` writes nested `memory.char_limits.{memory,user_profile}` (different shape) — also ignored. Memory tab implementation MUST add the block with FLAT keys (`memory.memory_char_limit`, `memory.user_char_limit`) Hermes actually reads.
