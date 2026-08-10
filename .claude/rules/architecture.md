# Architecture Rules

- Dependencies flow inward only: domain → application → infrastructure.
- One module per file. File name matches primary export. One public UI component per file; co-locate its previews and private helpers.
- Feature-based organization. Group by domain, not by type. One screen per package; split a crowded package into concept sub-packages so location predicts contents.
- The app entry point does setup only, then delegates to a state-driven navigation gate; the gate and each screen's host live in their own files.
- Define interfaces at boundaries. Concrete implementations behind interfaces.
- Split a unit the moment its responsibilities diverge; let logical cohesion, not size, drive the boundary.

> When a rule is unclear, read `agents/docs/architecture-details.md`.
