# Task Brief: Web calendar route, REST client, and view

## Contribution Goal

Deliver the web calendar feature: a REST client service, a calendar icon, a top-level route, and a calendar view that lists/creates/updates/deletes events via the /api/v1/calendar REST surface.

## Boundary — Included

- gateway/webui/src/services/calendar-api.ts REST client (typed, bearer headers, no content logging)
- A calendar icon added to the icon registry and IconName
- A top-level calendar route and view component (list/create/update/delete via REST) with local refresh
- Vitest tests for the REST client and view behavior

## Required Work

- 1. Create gateway/webui/src/services/calendar-api.ts with typed GET/POST/PATCH/DELETE/list methods using bearer headers and handleFetch; URL-encode ids; do not log content.
- 2. Add a calendar icon to the icon registry and IconName in icon.tsx/components/common/icons/.
- 3. Add a calendar top-level route in app.tsx and a calendar view component that lists events (with week/day expansion rendering), and create/update/delete via REST with local refresh.
- 4. Add Vitest tests for calendar-api wire shapes and the view's list/create/update/delete behavior.
- 5. Run webui tests and typecheck.

## Integration Expectation

Deliver this contribution for integration in stage s6-web-ui.

## Context

- webui is Preact/Vitest; top-level routes are in gateway/webui/src/app.tsx (TopbarRoute) selecting ChatView/SettingsView.
- Settings nav lives in gateway/webui/src/components/settings/sidebar/nav-config.ts (SidebarKey) and sidebar-nav.tsx; panes in settings-view.tsx.
- REST client precedent is gateway/webui/src/services/profile-api.ts (bearer headers, typed handleFetch mapping).
- Memory pane (memory-pane.tsx) is the feature template; icons are registered in icon.tsx and components/common/icons/; no calendar icon exists yet.
- Calendar CRUD should be immediate REST mutations with local refresh, not the profile Apply bar.

## Boundary — Excluded

- Mobile clients
- Gateway REST handler (s4-rest-api)

## Interfaces and Dependencies

- Produces: web calendar route and REST client consuming /api/v1/calendar from s4-rest-api.
- Consumes: existing webui app, settings nav, icon registry, and REST client patterns.
