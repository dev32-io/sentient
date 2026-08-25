# Task Acceptance: Build the WebUI foundation/common component system and Rive identity adapter

## Deliverables

- Provide native Preact/CSS primitives and common composites that implement the reviewed Dusk material system, plus a thin three-state Rive identity wrapper backed by platform-owned asset copies.

## Acceptance

- No production Web import, URL, or runtime dependency references design/prototype/**.
- Packaged Rive bytes exactly match the canonical manifest and fallback remains usable.
- Foundation controls preserve exact material physics and generated tokens without page-local design literals.
- Exactly idle/thinking/responding are exposed; listening cannot reach the identity adapter.
- Keyboard, focus, coarse-pointer targets, narrow layout, 200% zoom, and Reduced Motion are covered at stable component boundaries.

## Boundary Proof

- Component tests pin semantics/state mapping/fallback and dialog focus behavior.
- Build/check pins copied asset SHA-256 and generated token use.
- Web build/typecheck and design:avatar verification prove packaging/runtime prerequisites.
