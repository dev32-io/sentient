# Evaluation Report: final-e2e

## Boundary

{"workItem":"first-class-family-tools"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

Fresh local E2E reached the real https://localhost/ stack, authenticated Ada with local PIN 1234, and verified the Tools journey at desktop and 390x844. The UI/API exposed native web (web_search, fetch_content, read_web_content), home (31 tools), and music (11 tools) product groups; metadata showed native dispatch and standard web exposure. The complete web journey could not run because sentient-outbound-worker repeatedly restarts: its configured bundled policy path /app-dangerous-domains.txt is absent, producing 'bundled domain policy unavailable' at /app/src/domain-policy.ts:77. This blocks required grounded search/fetch/artifact E2E evidence.

## Evidence

- **EV-001:** Fresh local stack status. — gateway ready, door ready, vite ready; sentient-outbound-worker Restarting (1)
- **EV-002:** Exact runtime blocker captured during startup. — error: bundled domain policy unavailable at /app/src/domain-policy.ts:77
- **EV-003:** Structured browser observations and journey steps. — Authenticated local user; Tools page showed web 3/3, home 31/31, music 11/11; 390x844 rendered the same contract.

## Findings

- **E2E-001** (critical, open): Outbound worker restart loop caused by missing bundled dangerous-domain policy path prevents web_search/fetch/artifact E2E.
- **E2E-002** (medium, open): Readiness reports the stack ready while required outbound-worker is restarting.

## Verdict

blocked

## Residual Risk

- Web search, fetch, redirect policy, artifact retrieval, and cited bounded output remain unverified at runtime.
- Home and Music native tools were catalogued but no live household reads or writes were attempted; write paths remain unverified through controlled doubles in this E2E boundary.
- stack:status reported gateway/door/vite ready despite outbound-worker restarting.
