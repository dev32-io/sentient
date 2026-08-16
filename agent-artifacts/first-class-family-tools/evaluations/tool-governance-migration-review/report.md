# Evaluation Report: tool-governance-migration-review

## Boundary

{"workItem":"first-class-family-tools"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

# Tool governance migration final review

## Verdict
PASS for committed implementation at `abeb24dad6a2af6a1ec20b70eca388d1086ce40d`, including repair `5715e0c9b05be66eac2d9282fd36b98d04e46411`.

## Findings
TGMR-001 and TGMR-002 are resolved. Partial legacy maps preserve omitted retired core groups as off, explicit restrictive mappings remain restrictive, and migration is idempotent. Delegated native reads are advertised and dispatched only when current role and product permission resolve allow; ask/deny/off, role-denied, advanced default-off, and side-effecting tools remain unavailable. Advanced gateway tools remain visible/settable as native product tools, and third-party MCP behavior is preserved.

## Verification
Focused gateway/delegation suite passed 123 tests; migration matrix covered 15 partial legacy shapes and 8 explicit deny/off cases. Web settings passed 21 tests. KMP allTests built successfully. Typecheck and diff checks passed.

## Evidence

- **EV-001:** focused gateway migration/catalog/broker/delegation suite — 123 passed, 0 failed
- **EV-002:** partial legacy migration matrix — 15 shapes idempotent; 8 deny/off mappings preserved
- **EV-003:** web settings permission tests — 21 passed, 0 failed
- **EV-004:** JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew :shared:mobile-sdk:allTests — BUILD SUCCESSFUL
- **EV-005:** source scripts/env.sh && bun run typecheck && git diff --check — Passed

## Findings

- **TGMR-001** (high, resolved): Partial and repeated migrations preserve omitted core groups as off and explicit restrictions without widening.
- **TGMR-002** (high, resolved): Advertisement and dispatch enforce current allow-only policy while preserving settings visibility and third-party MCP behavior.

## Verdict

pass

## Residual Risk

- No dedicated create-mcp-host.test.ts exists; assembly confidence comes from hosted/native surface tests, catalog tests, static inspection, and typecheck.
- KMP execution was largely up-to-date.
