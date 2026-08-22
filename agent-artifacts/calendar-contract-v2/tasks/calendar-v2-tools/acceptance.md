# Task Acceptance: Replace all six model-facing calendar tool adapters

## Deliverables

- The model can safely use every calendar tool with concise strings, explicit recurrence mutation scope, complete bounded results, and actionable failures while existing tiers and role gates remain unchanged.

## Acceptance

- Every tool accepts only its concise V2 shape and omitted scope means private.
- Search cannot run without explicit from/to; reads alone may request all.
- Recurring update/delete always carries applyTo and uses eventId plus originalStart where required.
- Child household writes emit no permission request and perform no service/store call.
- Oversized results are rejected intact with result_too_large before broker truncation.
- All errors are actionable and contain no calendar content or hidden-scope leakage.

## Boundary Proof

- Provider tests cover schemas, runners, security gates, cancellation, errors, identity, and output limits for all six tools.
- Disposable tool integration proves E2E-001 through E2E-013 model-visible behavior.
- Generic cap spy proves no successful calendar result is truncated.
