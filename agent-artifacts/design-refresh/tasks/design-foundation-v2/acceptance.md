# Task Acceptance: Establish the additive design-foundation v2 contract and generated projections

## Deliverables

- Create one versioned, machine-checkable design foundation in the shared KMP module and deterministic Web projections without changing Android's existing v1 visual consumers.

## Acceptance

- All exact values and named material/identity descriptors are available from one versioned source and deterministic projections.
- design:foundation:check detects stale or manually edited generated outputs and checksum mismatch.
- Existing Android v1 declarations and Android UI files are unchanged.
- Generated files include clear headers and are not depended on by prototype JavaScript.

## Boundary Proof

- Focused generator/contract tests demonstrate determinism, exact values, and drift rejection.
- KMP Android compilation demonstrates additive compatibility; Web typecheck validates the generated TypeScript projection.
