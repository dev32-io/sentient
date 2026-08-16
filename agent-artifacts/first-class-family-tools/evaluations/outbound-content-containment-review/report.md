# Evaluation Report: outbound-content-containment-review

## Boundary

{"workItem":"first-class-family-tools"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

Evaluated commit 8ac582dc402dcb4fe6cfa673c649676b8fccb687 read-only.

Requirement conclusions:
- PASS — Network confinement: outbound-worker is internal-only and unpublished; its managed dependency includes egress-proxy, and loopback ingress exposes only the narrow worker API. Static search found the model URL dereference only in the web worker client path.
- PASS — URL policy: HTTP/HTTPS, credential rejection, ports, DNS failure, case/trailing-dot/IDNA normalization, suffix denial, and redirect-by-redirect checks are implemented and covered.
- FAIL — Resource/malformed-response bounds: page fetch streaming, redirects, compression/decompression, extraction, cancellation, and source concurrency are bounded, but SearXNG and gateway worker responses are fully buffered before their size limits are checked (OCCR-002).
- PASS — Artifacts: IDs are opaque, capability-rooted and owner-checked; malformed, foreign, expired, and evicted reads return no content; slices/passages, modes, TTL, and capacity are covered.
- FAIL — Context containment: short pages are returned whole by fetch_content and sent whole to the utility model by grounded web_search, without explicit read_web_content slicing (OCCR-001).
- PASS — Scanning/logging: utility passages and summaries cross the inbound gate, all native tool results cross the broker gate before capping, and reviewed web paths log no query/body/summary content.
- PASS — Summary fallbacks: selected user model resolves at request time, then one configured fallback, then deterministic formatting; every model attempt sends tools:[] and uses shared input/output/deadline bounds.
- PASS — Required checks: 707 pass, 2 skipped, 0 fail; typecheck passed; git diff --check passed.

Overall: FAIL because the central complete-page containment promise is reproducibly violated and malformed upstream responses can bypass intended memory bounds.

## Evidence

- **EV-001:** Required regression suite. — 707 pass, 2 skip, 0 fail
- **EV-002:** source scripts/env.sh && bun run typecheck — All workspace typechecks exited 0.
- **EV-003:** source scripts/env.sh && git diff --check — Exit 0.
- **EV-004:** Read-only mocked runtime reproduction; script and output are outside the repository. — fullBodyInFetchToolResult=true and fullBodyInUtilityPrompt=true for a 22-character fetched page.

## Findings

- **OCCR-001** (high, open): Short fetched pages enter both fetch_content results and grounded utility prompts in full.
- **OCCR-002** (medium, open): Response size checks occur only after response.text() has buffered the entire SearXNG or worker response.

## Verdict

fail

## Residual Risk

- Network confinement was established from topology/config tests and code inspection, not a live egress-proxy outage test.
- No live benign public-page E2E was run; the review remained local and non-mutating.
