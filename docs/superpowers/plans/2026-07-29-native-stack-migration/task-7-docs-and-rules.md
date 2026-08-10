### Task 7: Docs & rules sweep

**Wave 3 · model: sonnet · spec §8.4**

Runs concurrently with Task 6. **Touch no source file and not `gateway/config.yaml`** — Task 6 owns those.

A rule describing a dead mechanism is worse than no rule: an agent will follow it. This task makes the documentation describe what actually shipped.

**Files:**
- Modify: `.claude/rules/gateway/mcp-deployment.md`, `.claude/rules/e2e-testing.md`
- Modify: `CLAUDE.md`, `gateway/CLAUDE.md`, `deploy/README.md`
- Modify: `agents/docs/e2e-testing-details.md`, `agents/docs/testing-knowledge.md`
- Modify: compose file headers in `deploy/macos/` and `deploy/mac-prod/`

Rules files stay **direct** — instructions only, no prose, no examples. Examples belong in `agents/docs/<topic>-details.md`. Read `.claude/rules/` first for the established voice.

---

- [ ] **Step 1: Inventory every stale claim**

```bash
grep -rn "docker compose\|docker-compose\|sentient-gateway\|host.docker.internal" \
  .claude/rules/ CLAUDE.md gateway/CLAUDE.md deploy/README.md agents/docs/ 2>/dev/null
grep -rn "publish NO host ports\|forbidden" .claude/rules/gateway/mcp-deployment.md
```
Record every hit. Each is either updated or deliberately kept (some genuinely still describe addon containers, which remain dockerized).

- [ ] **Step 2: Rewrite the MCP port rule — preserve the intent, change the mechanism**

In `.claude/rules/gateway/mcp-deployment.md`, the line "MCP containers attach to `sentient-internal` and publish NO host ports. Adding `ports:` to an MCP service is forbidden; document this inline" is now **wrong**: the native gateway cannot reach docker DNS, and macOS Docker Desktop bridge IPs are not host-routable.

Do **not** simply delete it. Replace with:

```markdown
- MCP containers attach to `sentient-internal` and publish host ports **bound to `127.0.0.1` only** (`"127.0.0.1:8086:8086"`). The native gateway dials them over loopback. A `ports:` entry without the explicit `127.0.0.1` prefix is a defect — docker's default bind is `0.0.0.0`, which exposes the MCP to the LAN.
- MCP containers are never LAN-reachable. Only the gateway's `8888` is.
```

- [ ] **Step 3: Update the E2E bring-up rule**

In `.claude/rules/e2e-testing.md`, the local stack is no longer `docker compose up` for the gateway. Replace the bring-up wording with the native path: addons via compose, gateway via `launchctl` (prod) or `bun --hot src/main.ts` (dev). Keep every other rule — the prod-is-observational-only guard, the Maestro-for-native rule, and the tag-batch execution model are unchanged and still correct.

- [ ] **Step 4: Update `CLAUDE.md` and `gateway/CLAUDE.md`**

Fix: the architecture summary (the gateway is a native host orchestrator supervising docker + native addons), the commands section, and any wording implying the gateway ships as a container. `gateway/CLAUDE.md` still says "Orchestrates STT→LLM→TTS streaming pipeline on Raspberry Pi 5" — the Pi is long retired; correct it.

- [ ] **Step 5: Update `deploy/README.md` and both compose headers**

The compose files no longer contain a gateway service. Their headers currently document a first-boot flow that starts with building the gateway image — rewrite to: build the gateway binary with `scripts/build-gateway.sh`, install it with `setup-prod.py`, and use compose only for addons.

- [ ] **Step 6: Update the details docs**

`agents/docs/e2e-testing-details.md` carries the canonical bring-up command block. Replace it with the native sequence. In `agents/docs/testing-knowledge.md`, add a banner noting that every case authored before this migration assumed a containerized gateway and the retired cycle wire — Tasks 9/10 re-ground them.

- [ ] **Step 7: Verify no stale instruction survives**

```bash
grep -rn "docker compose.*gateway\|compose.*up.*gateway" .claude/rules/ CLAUDE.md gateway/CLAUDE.md deploy/README.md agents/docs/
grep -rn "host.docker.internal" .claude/ CLAUDE.md deploy/ agents/docs/
grep -rn "publish NO host ports" .claude/rules/
grep -rn "Raspberry Pi" gateway/CLAUDE.md
```
Expected: **no matches** for all four. Any hit is a doc still describing the old world.

- [ ] **Step 8: Commit**

This task changes no code, so there is nothing to unit-test; Step 7's greps are the verification.

```bash
git commit -m "docs: describe the native stack instead of the container stack" -- \
  .claude/rules/ CLAUDE.md gateway/CLAUDE.md deploy/README.md agents/docs/ \
  deploy/macos/docker-compose.yml deploy/mac-prod/docker-compose.yml
```
