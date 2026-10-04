# Design refresh verification contracts

This directory defines accountability and local-harness contracts; historical reviewed labels are not proof of closure for the WebUI and iOS refresh.

- `inventory.json` contains one stable row per reachable significant surface/state and explicit rows for dormant exports. Platform-owned registries at `gateway/webui/src/design-refresh-reachability.json` and `ios/App/design-refresh-reachability.json` are the closed source discovery contract; the checker derives required rows and implementation paths from them.
- `inventory.schema.json` and `contracts.ts` define row/configuration/owner fields. `check.ts` requires the implementation inventory to be closed and validates source-registry coverage, files, owners, authority paths, final-case mapping, asset copies, and production isolation from `design/prototype/`. Visual-review verdicts remain pending until final review; `--require-closed` additionally enforces those verdicts.
- `e2e-matrix.json` maps E2E-001 through E2E-009 exactly once and retains setup, action, outcome, evidence, and safety clauses.
- `visual-review.json` and its schema define semantic review. Pending entries declare required configurations; reviewed entries add sanitized regular evidence files plus overflow, minimum-target, and focus measurements where applicable. Each reviewed entry must reference a JSON sidecar (`kind: design-refresh-visual-evidence`) that maps its inventory ID and every required configuration to actual render/simulator capture paths; placeholder notes and measurements are rejected. Each capture also requires `provenancePath`, pointing to a `tools/visual-diff/evidence.mjs` manifest bound to actual production inventory ID/implementation path, source/reference/image hashes, decoded dimensions, runtime, viewport and font/theme identities. Failed, inconsistent, stale or unknown measurements cannot close review. No checker performs pixel comparison.
- `fixture-control.ts` creates one synthetic disposable user through the existing local admin boundary. Deleting that user invokes the gateway's whole-user archival/deletion flow, which owns private profile, session, and calendar storage. State files contain generated IDs only and are mode `0600`.
- `run-web-text-only.sh` and `run-ios-text-only.sh` provision fixtures under a temporary directory and clean them in an exit trap. Calendar cases delegate to the existing Calendar fixture lifecycle.

Run:

```bash
bun run design:inventory:check
bun test qa/design-refresh
bun run design:e2e:web -- E2E-001   # requires DESIGN_REFRESH_WEB_DRIVER
bun run design:e2e:ios -- E2E-006   # signed, installed simulator debug build
```

The iOS entrypoint verifies the installed app signature, never grants microphone access, never enters a fault phase, and restores the original Dynamic Type value on exit. All targets are explicit loopback HTTP(S); production and connectivity mutation are rejected by contract.

## Evidence closure

Implementation tasks change inventory and visual entries from `planned`/`pending` to `reviewed`, attach files only beneath the platform design-refresh evidence root, and enter measured values. Evidence must use clearly synthetic disposable text and omit authentication material, private household content, model input/output logs, speech-derived text, sound files, and live deployment identifiers. Visual acceptance is structured review, not pixel-perfect automation.

iOS inventory catalog previously rendered generic notice/field/button substitutes rather than named surfaces. It now displays explicit missing-fixture labels, and `capture-ios-visual-review.sh` fails unavailable before simulator mutation. No constant target/focus/overflow values are generated. Existing reviewed JSON is retained for audit history; `check.ts --require-closed` rejects legacy sidecars, not retroactively certifies them.

Use `tools/visual-diff/coverage.mjs` for full handoff + shipped/source/native-only gaps and `scripts/design/capture-ios-visual-diff.sh` for registered real components **only after explicit disposable simulator allocation**. Captures export fresh registry routing plus provenance; accessibility/layout remain unknown until measured by native tests. Foundation catalog remains a separate exploratory tool, not named screen coverage.

Web legacy catalog captures also need provenance upgrade before closure. The checker requires passing, consistent measured observations for each required configuration, not merely file existence. `applicable:"unknown"` records unavailable measurement and never closes review. `applicable:false` is only a reviewed non-applicability reason, not a substitute for missing measurement.
