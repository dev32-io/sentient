# Task Brief: iOS calendar SwiftUI screen, route, and ViewModel

## Contribution Goal

Deliver the iOS SwiftUI calendar screen, Route case, UserSessionHost destination, ViewModel (consuming shared use cases), and settings-row entry consuming the mobile-data calendar use cases.

## Boundary — Included

- ios CalendarScreen + CalendarViewModel consuming shared calendar use cases via SettingsComponent
- Route.swift case and UserSessionHost.destination(for:) case
- Settings-root calendar row entry
- Accessibility identifiers consistent with existing contracts
- Unit tests for the ViewModel state folding

## Required Work

- 1. Add a settingsCalendar case to Route.swift and a destination in UserSessionHost.destination(for:).
- 2. Create CalendarViewModel and CalendarScreen consuming the shared calendar use cases via SettingsComponent (not raw repositories) with list/create/update/delete.
- 3. Add a settings-root calendar row entry with accessibility IDs consistent with existing contracts.
- 4. Add unit tests for ViewModel state folding and screen wiring.
- 5. Build the MobileData XCFramework, then build and run iOS tests on the simulator using ios/SentientApp.xcodeproj and scheme SentientApp, preserving exit status.

## Integration Expectation

Deliver this contribution for integration in stage s8-ios.

## Context

- iOS precedent is ios/App/Settings/Memory/MemoryScreen.swift receiving SettingsComponent and onBack.
- Navigation types are ios/App/Nav/Route.swift and UserSessionHost.swift (e.g. case settingsMemory).
- The iOS project is the XcodeGen-generated ios/SentientApp.xcodeproj with scheme SentientApp (per ios/README.md); build the MobileData XCFramework first.
- Screens consume SettingsComponent, not raw SDK clients; platform ViewModels must consume shared use cases (not raw repositories).
- Accessibility IDs are part of mobile E2E contracts; preserve xcodebuild exit status (no pipe-to-tail that masks failures).

## Boundary — Excluded

- Android screen
- mobile-data repo (s7-mobile-data)

## Interfaces and Dependencies

- Produces: iOS calendar screen and nav consuming calendar use cases from s7-mobile-data.
- Consumes: mobile-data calendar use cases; existing Route/UserSessionHost seams; MobileData XCFramework.
