# Task Acceptance: Build the SwiftUI design-v2 projection, primitives, and common composites

## Deliverables

- Provide a native SwiftUI foundation/common layer that projects additive KMP v2 values exactly, preserves platform behavior, and replaces page-local visual primitives without changing domain ownership.

## Acceptance

- Swift v2 accessors agree with the KMP contract version/hash and exact locked values.
- Pages can compose all required reviewed primitives/common states without introducing raw styled controls.
- Native navigation, sheets, alerts, menus, focus, keyboard, safe areas, and Dynamic Type remain authoritative.
- The boundary checker detects unauthorized visual literals while permitting named structural geometry.
- No Android UI source and no prototype runtime file is imported or modified.

## Boundary Proof

- Projection/unit tests pin KMP-to-Swift values and component semantic states.
- Previews cover normal/accessibility text sizes, reduced motion, contrast, and principal state variants.
- Signed simulator build/tests demonstrate native integration.
