# Mobile navigation details

This file expands `.claude/rules/mobile-shared.md` for navigation questions.

Android and authenticated iOS use typed navigation. Routes carry typed, minimal identifiers; do not build destinations from ad-hoc strings or pass live SDK/session objects through a route. A route argument change creates the corresponding fresh screen ViewModel.

The authenticated root remains mounted while transport recovers: do not navigate to login because a WebSocket is temporarily down. Auth/configuration gates choose setup, login, or the authenticated chat root; logout clears auth and tears down the user/connection scope.

Navigation owns route state; screen ViewModels own route-scoped UI state. Commands go through the `UserSession`/`ChatComponent` usecases rather than directly reaching into the SDK from a view. Define one consistent back target for each typed destination.
