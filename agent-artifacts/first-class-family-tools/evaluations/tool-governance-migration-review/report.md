# Evaluation Report: tool-governance-migration-review

## Boundary

{"workItem":"first-class-family-tools"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

Two blocking authorization/migration regressions remain.

Requirement conclusions:
- PASS — ToolBroker definitions and dispatch use the shared resolver, dispatch refreshes permissions, role remains an independent ceiling, and explicit-tool > group-wildcard > default precedence is implemented.
- PASS — Focused web and KMP patch contracts pass, and provider contribution slots compose through one registry.
- FAIL — Conservative legacy migration: partial non-empty legacy maps lose the old absent-server=`off` restriction and can enable native replacement tools through role defaults.
- FAIL — Advanced/default-off and gateway restriction governance: delegated gateway-hosted tools are tier-filtered but bypass per-user product permissions; their shipped advanced stdio group is also omitted from the settings projection.
- PARTIAL — Delegated first-class web/home/music reads are broker-mediated and side-effect tiers are filtered, but hosted gateway model tools remain outside the same PDP.

The evaluated worktree was left unchanged.

## Evidence

- **EV-001:** source scripts/env.sh && bun test gateway/src/tools/resolve-tool-permission.test.ts gateway/src/tools/tool-broker.test.ts gateway/src/api/handlers/mcp-catalog.test.ts gateway/src/admin/web-tools-migrator.test.ts gateway/src/bootstrap/product-tool-providers.test.ts — 107 pass, 0 fail
- **EV-002:** source scripts/env.sh && bun --cwd gateway/webui test --run src/components/settings/panes/tool-permission-patch.test.ts — 19 pass, 0 fail
- **EV-003:** source scripts/env.sh && ./gradlew :shared:mobile-sdk:allTests — BUILD SUCCESSFUL; most tasks UP-TO-DATE
- **EV-004:** source scripts/env.sh && bun test gateway/src/mcp-host/native-tool-surface.test.ts gateway/src/mcp-host/proxied-tool-surface.test.ts gateway/src/bootstrap/create-mcp-host.test.ts gateway/src/external-tools/delegated-tool-tier.test.ts — 12 pass, 0 fail across 3 discovered files
- **EV-005:** source scripts/env.sh && bun run typecheck — All workspace typechecks exited 0
- **EV-006:** bun -e <legacy-vs-migrated permission comparison> — Legacy absent searxng resolved profile off; after migration native web_search resolved role-template allow.
- **EV-007:** Static code evidence — Hosted gateway tools are selected only by tier at create-mcp-host.ts:149-158; stdio catalog entries are excluded by mcp-catalog.ts:132-135; shipped gateway is advanced stdio at config.yaml:792-821.

## Findings

- **TGMR-001** (high, open): Partial legacy permission maps silently enable formerly-off core groups after migration.
- **TGMR-002** (high, open): Delegated gateway-hosted tools bypass product permissions and their advanced gateway group is hidden from settings.

## Verdict

fail

## Residual Risk

- The KMP allTests invocation succeeded but Gradle reported most test tasks UP-TO-DATE rather than re-executing them.
- No live/local-stack smoke was performed; evidence is static analysis and automated unit/contract checks only.
