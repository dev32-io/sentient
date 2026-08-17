# Task Brief: iOS calendar SwiftUI screen, route, and ViewModel

## Contribution Goal

Deliver the iOS SwiftUI calendar screen, Route case, UserSessionHost destination, ViewModel, and settings-row entry consuming the mobile-data calendar repository.

## Boundary — Included

- ios CalendarScreen + CalendarViewModel consuming SettingsComponent calendar repository
- Route.swift case and UserSessionHost.destination(for:) case
- Settings-root calendar row entry
- Accessibility identifiers consistent with existing contracts
- Unit tests for the ViewModel state folding

## Required Work

- 1. Add a settingsCalendar case to Route.swift and a destination in UserSessionHost.destination(for:).
- 2. Create CalendarViewModel and CalendarScreen consuming SettingsComponent calendar repository with list/create/update/delete.
- 3. Add a settings-root calendar row entry with accessibility IDs consistent with existing contracts.
- 4. Add unit tests for ViewModel state folding and screen wiring.
- 5. Build and run iOS tests on the simulator.

## Integration Expectation

Deliver this contribution for integration in stage s8-ios.

## Context

- iOS precedent is ios/App/Settings/Memory/MemoryScreen.swift receiving SettingsComponent and onBack.
- Navigation types are ios/App/Nav/Route.swift and UserSessionHost.swift (e.g. case settingsMemory).
- Screens consume SettingsComponent, not raw SDK clients; the settings icon lives in the iOS settings row / account header.
- Accessibility IDs are part of mobile E2E contracts.

## Boundary — Excluded

- Android screen
- mobile-data repo (s7-mobile-data)

## Interfaces and Dependencies

- Produces: iOS calendar screen and nav consuming CalendarRepository from s7-mobile-data.
- Consumes: mobile-data calendar repository and use cases; existing Route/UserSessionHost seams.
