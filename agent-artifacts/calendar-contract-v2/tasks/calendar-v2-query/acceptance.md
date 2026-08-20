# Task Acceptance: Implement bounded effective-occurrence calendar queries

## Deliverables

- One shared query service provides authorized get/list/search projections, deterministic REST paging, and complete-or-error model results across private and household calendars.

## Acceptance

- Filters and search observe effective occurrence values, not stale base fields.
- A child sees an everyone override of an adults base occurrence only when that explicit occurrence is authorized, and does not see any other adults occurrence; an adults override on an everyone base is hidden.
- All-scope reads either return the complete authorized aggregate/page or a typed failure, never a misleading subset.
- REST cursors are deterministic and bounded; tools never return only the first page.
- Aggregate and serialized-size limits stop work and return actionable result_too_large before broker truncation.

## Boundary Proof

- Query service tests cover mixed time kinds, role visibility after overrides, stable sorting/cursors, scope failure, search/filter semantics, and both overflow modes.
- Nudge tests remain green against the effective query seam.
