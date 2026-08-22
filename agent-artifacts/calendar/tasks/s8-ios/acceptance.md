# Task Acceptance: iOS calendar SwiftUI screen, route, and ViewModel

## Deliverables

- Deliver the iOS SwiftUI calendar screen, Route case, UserSessionHost destination, ViewModel (consuming shared use cases), and settings-row entry consuming the mobile-data calendar use cases.

## Acceptance

- The iOS calendar screen lists events from its ViewModel
- The ViewModel consumes shared calendar use cases (not the raw repository)
- A Route case, UserSessionHost destination, settings-row entry, and screen are added
- Accessibility identifiers follow existing mobile E2E contracts

## Boundary Proof

- iOS unit tests cover ViewModel state folding and screen wiring; build uses the authoritative project/scheme
