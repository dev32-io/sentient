# Sentient responsive prototype inventory

The primary product prototype is `sentient-responsive-prototype.html`. It is one self-contained, responsive application with in-page state and no theme toggle or external runtime dependency.

## Entry behavior

- Opens directly in the authenticated conversation experience.
- Direct hashes open major states: `#chat`, `#calendar`, `#settings`, `#setup`, `#login`, `#admin`, and `#update`.
- Settings are directly addressable: `#memory`, `#personalities`, `#voice`, `#audio`, `#model`, `#tools`, `#system`, `#advanced`, `#account`, `#get-app`, `#members`, `#secrets`, and `#diagnostics`.
- PIN for the prototype login is `1234`.

## Working flows

- **Conversation:** reveal past chats only from the top-left hamburger drawer, search and reopen them, rename/delete, create a new chat, send messages, use suggestions, attach files, toggle TTS and listening, interrupt tasks/replies, pause voice, and review permissions.
- **Calendar:** day/week/month/year views, period navigation, today reset, scope and tag filters, date selection, event preview/edit, recurrence controls, mutation scope, add/delete confirmation, and conflict feedback.
- **Settings:** memory, personalities, voices, audio, model, tools, system prompt, advanced controls, account, downloads, members, secrets, diagnostics, dirty-state apply/discard, and confirmation dialogs.
- **Account and recovery:** gateway setup, first administrator, profile/PIN login, connection loss/recovery, required update, and sign out.

## Responsive behavior

- Desktop uses a 64px topbar, route rail, constrained conversation column, and full calendar workspace.
- Tablet converts the rail into a modal drawer and removes peripheral metadata.
- Mobile recomposes settings rows, calendar cells, forms, dialogs, conversation bubbles, and actions without horizontal scrolling.
- The reusable avatar component in `design/shared/sentient-avatar.js` owns idle, thinking, and responding state transitions; the canonical SVG variants live in `design/shared/avatars/`.
