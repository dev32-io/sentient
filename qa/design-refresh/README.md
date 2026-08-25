# Design refresh verification contracts

This directory is the closed accountability and local-harness contract for the WebUI and iOS refresh.

- `inventory.json` contains one stable row per reachable significant surface/state and explicit rows for dormant exports. `reachability.json` is the closed required-ID set.
- `inventory.schema.json` and `contracts.ts` define row/configuration/owner fields. `check.ts` validates files, owners, authority paths, closure, final-case mapping, asset copies, and production isolation from `design/prototype/`.
- `e2e-matrix.json` maps E2E-001 through E2E-009 exactly once and retains setup, action, outcome, evidence, and safety clauses.
- `visual-review.json` and its schema define semantic review. Pending entries declare required configurations; reviewed entries add sanitized regular evidence files plus overflow, minimum-target, and focus measurements where applicable. No checker performs image comparison.
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
