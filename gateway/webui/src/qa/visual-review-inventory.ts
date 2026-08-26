// Generated from qa/design-refresh/inventory.json for the local QA-only render catalog.
export const webVisualRows = [
  {
    id: "web.install.loading",
    state: "install state loading",
  },
  {
    id: "web.install.wizard",
    state: "bootstrap incomplete wizard",
  },
  {
    id: "web.install.wizard.unlock",
    state: "locked installer unlock",
  },
  {
    id: "web.install.wizard.provider",
    state: "idle",
  },
  {
    id: "web.install.wizard.provider.testing",
    state: "testing",
  },
  {
    id: "web.install.wizard.provider.error",
    state: "error",
  },
  {
    id: "web.install.wizard.secrets",
    state: "idle",
  },
  {
    id: "web.install.wizard.secrets.saving",
    state: "saving",
  },
  {
    id: "web.install.wizard.secrets.error",
    state: "error",
  },
  {
    id: "web.install.wizard.voice",
    state: "available",
  },
  {
    id: "web.install.wizard.voice.unavailable",
    state: "unavailable",
  },
  {
    id: "web.install.wizard.bringup",
    state: "pending",
  },
  {
    id: "web.install.wizard.bringup.running",
    state: "running",
  },
  {
    id: "web.install.wizard.bringup.error",
    state: "error",
  },
  {
    id: "web.install.wizard.bringup.success",
    state: "success",
  },
  {
    id: "web.install.wizard.finish",
    state: "bootstrap completion",
  },
  {
    id: "web.auth.boot",
    state: "authentication hydration loading",
  },
  {
    id: "web.auth.user-list.loading",
    state: "initial user list loading or retry",
  },
  {
    id: "web.auth.setup",
    state: "idle",
  },
  {
    id: "web.auth.setup.submitting",
    state: "submitting",
  },
  {
    id: "web.auth.setup.error",
    state: "error",
  },
  {
    id: "web.auth.login-picker",
    state: "user picker",
  },
  {
    id: "web.auth.pin",
    state: "idle",
  },
  {
    id: "web.auth.pin.submitting",
    state: "submitting",
  },
  {
    id: "web.auth.pin.error",
    state: "error",
  },
  {
    id: "web.auth.failed",
    state: "authentication failed with retry",
  },
  {
    id: "web.shell.chat",
    state: "authenticated Chat route",
  },
  {
    id: "web.shell.topbar",
    state: "route navigation and household identity",
  },
  {
    id: "web.shell.notifications-noop",
    state: "visible notification control with no implementation",
  },
  {
    id: "web.shell.user-menu",
    state: "closed",
  },
  {
    id: "web.shell.user-menu.open",
    state: "open",
  },
  {
    id: "web.history.closed",
    state: "closed",
  },
  {
    id: "web.history.loading",
    state: "open loading",
  },
  {
    id: "web.history.list",
    state: "open populated and active row",
  },
  {
    id: "web.history.empty",
    state: "no sessions",
  },
  {
    id: "web.history.no-results",
    state: "search has no matches",
  },
  {
    id: "web.history.error",
    state: "empty error and stale-list retry",
  },
  {
    id: "web.history.row-menu",
    state: "row actions open",
  },
  {
    id: "web.history.rename",
    state: "idle",
  },
  {
    id: "web.history.rename.invalid",
    state: "invalid",
  },
  {
    id: "web.history.rename.submitting",
    state: "submitting",
  },
  {
    id: "web.history.delete",
    state: "destructive confirmation",
  },
  {
    id: "web.chat.empty",
    state: "new conversation empty state",
  },
  {
    id: "web.chat.user-message",
    state: "durable user message",
  },
  {
    id: "web.chat.assistant-thinking",
    state: "assistant thinking before text",
  },
  {
    id: "web.chat.assistant-responding",
    state: "streaming assistant response",
  },
  {
    id: "web.chat.assistant-complete",
    state: "completed assistant response",
  },
  {
    id: "web.chat.interrupted",
    state: "foreground response interrupted",
  },
  {
    id: "web.chat.tool-detail",
    state: "legacy tool detail export is dormant and not rendered by ChatView",
  },
  {
    id: "web.chat.tasks",
    state: "running",
  },
  {
    id: "web.chat.tasks.done",
    state: "done",
  },
  {
    id: "web.chat.tasks.error",
    state: "error",
  },
  {
    id: "web.chat.connection-lost",
    state: "connection lost with reconnect action",
  },
  {
    id: "web.chat.permission",
    state: "permission decision required",
  },
  {
    id: "web.chat.toast",
    state: "success",
  },
  {
    id: "web.chat.toast.error",
    state: "error",
  },
  {
    id: "web.composer.idle",
    state: "empty draft and suggestions",
  },
  {
    id: "web.composer.draft",
    state: "text draft and enabled send",
  },
  {
    id: "web.composer.reconnecting",
    state: "send disabled with retained draft",
  },
  {
    id: "web.composer.interrupt",
    state: "active text response interrupt",
  },
  {
    id: "web.composer.tts",
    state: "enabled",
  },
  {
    id: "web.composer.tts.disabled",
    state: "disabled",
  },
  {
    id: "web.composer.tts.applying",
    state: "applying",
  },
  {
    id: "web.composer.mic",
    state: "idle",
  },
  {
    id: "web.composer.mic.hold",
    state: "hold",
  },
  {
    id: "web.composer.mic.locked",
    state: "locked",
  },
  {
    id: "web.composer.mic.error",
    state: "error",
  },
  {
    id: "web.settings.route",
    state: "authenticated Settings route and sidebar",
  },
  {
    id: "web.settings.loading",
    state: "profile-gated pane loading",
  },
  {
    id: "web.settings.memory",
    state: "idle",
  },
  {
    id: "web.settings.memory.loading",
    state: "loading",
  },
  {
    id: "web.settings.memory.empty",
    state: "empty",
  },
  {
    id: "web.settings.memory.error",
    state: "error",
  },
  {
    id: "web.settings.personalities",
    state: "idle",
  },
  {
    id: "web.settings.personalities.loading",
    state: "loading",
  },
  {
    id: "web.settings.personalities.empty",
    state: "empty",
  },
  {
    id: "web.settings.personalities.error",
    state: "error",
  },
  {
    id: "web.settings.voice",
    state: "idle",
  },
  {
    id: "web.settings.voice.loading",
    state: "loading",
  },
  {
    id: "web.settings.voice.empty",
    state: "empty",
  },
  {
    id: "web.settings.voice.error",
    state: "error",
  },
  {
    id: "web.settings.audio",
    state: "idle",
  },
  {
    id: "web.settings.audio.loading",
    state: "loading",
  },
  {
    id: "web.settings.audio.empty",
    state: "empty",
  },
  {
    id: "web.settings.audio.error",
    state: "error",
  },
  {
    id: "web.settings.model",
    state: "idle",
  },
  {
    id: "web.settings.model.loading",
    state: "loading",
  },
  {
    id: "web.settings.model.empty",
    state: "empty",
  },
  {
    id: "web.settings.model.error",
    state: "error",
  },
  {
    id: "web.settings.tools",
    state: "idle",
  },
  {
    id: "web.settings.tools.loading",
    state: "loading",
  },
  {
    id: "web.settings.tools.empty",
    state: "empty",
  },
  {
    id: "web.settings.tools.error",
    state: "error",
  },
  {
    id: "web.settings.system-prompt",
    state: "idle",
  },
  {
    id: "web.settings.system-prompt.loading",
    state: "loading",
  },
  {
    id: "web.settings.system-prompt.empty",
    state: "empty",
  },
  {
    id: "web.settings.system-prompt.error",
    state: "error",
  },
  {
    id: "web.settings.advanced",
    state: "idle",
  },
  {
    id: "web.settings.advanced.loading",
    state: "loading",
  },
  {
    id: "web.settings.advanced.empty",
    state: "empty",
  },
  {
    id: "web.settings.advanced.error",
    state: "error",
  },
  {
    id: "web.settings.account",
    state: "idle",
  },
  {
    id: "web.settings.account.loading",
    state: "loading",
  },
  {
    id: "web.settings.account.empty",
    state: "empty",
  },
  {
    id: "web.settings.account.error",
    state: "error",
  },
  {
    id: "web.settings.members",
    state: "idle",
  },
  {
    id: "web.settings.members.loading",
    state: "loading",
  },
  {
    id: "web.settings.members.empty",
    state: "empty",
  },
  {
    id: "web.settings.members.error",
    state: "error",
  },
  {
    id: "web.settings.secrets",
    state: "idle",
  },
  {
    id: "web.settings.secrets.loading",
    state: "loading",
  },
  {
    id: "web.settings.secrets.empty",
    state: "empty",
  },
  {
    id: "web.settings.secrets.error",
    state: "error",
  },
  {
    id: "web.settings.get-app",
    state: "idle",
  },
  {
    id: "web.settings.get-app.loading",
    state: "loading",
  },
  {
    id: "web.settings.get-app.empty",
    state: "empty",
  },
  {
    id: "web.settings.get-app.error",
    state: "error",
  },
  {
    id: "web.settings.apply.dirty",
    state: "pending changes",
  },
  {
    id: "web.settings.apply.applying",
    state: "apply in progress",
  },
  {
    id: "web.settings.apply.success",
    state: "apply completed",
  },
  {
    id: "web.settings.apply.error",
    state: "apply failed or timed out",
  },
  {
    id: "web.settings.apply.discard",
    state: "discard confirmation/action",
  },
  {
    id: "web.settings.members.add",
    state: "idle",
  },
  {
    id: "web.settings.members.add.submitting",
    state: "submitting",
  },
  {
    id: "web.settings.members.add.error",
    state: "error",
  },
  {
    id: "web.settings.members.add.success",
    state: "success",
  },
  {
    id: "web.calendar.route",
    state: "authenticated Calendar route",
  },
  {
    id: "web.calendar.loading",
    state: "initial loading and background refresh",
  },
  {
    id: "web.calendar.empty",
    state: "empty or unavailable calendar",
  },
  {
    id: "web.calendar.error",
    state: "load error",
  },
  {
    id: "web.calendar.error.mutation-error",
    state: "mutation error",
  },
  {
    id: "web.calendar.day",
    state: "Day view",
  },
  {
    id: "web.calendar.week",
    state: "Week view",
  },
  {
    id: "web.calendar.month",
    state: "Month view",
  },
  {
    id: "web.calendar.year",
    state: "Year view",
  },
  {
    id: "web.calendar.filters",
    state: "open",
  },
  {
    id: "web.calendar.filters.selected",
    state: "selected",
  },
  {
    id: "web.calendar.filters.no-match",
    state: "no match",
  },
  {
    id: "web.calendar.preferences",
    state: "view and calendar preferences",
  },
  {
    id: "web.calendar.preview",
    state: "positioned",
  },
  {
    id: "web.calendar.preview.open",
    state: "open",
  },
  {
    id: "web.calendar.editor.create",
    state: "idle",
  },
  {
    id: "web.calendar.editor.create.invalid",
    state: "invalid",
  },
  {
    id: "web.calendar.editor.create.saving",
    state: "saving",
  },
  {
    id: "web.calendar.editor.create.error",
    state: "error",
  },
  {
    id: "web.calendar.editor.create.success",
    state: "success",
  },
  {
    id: "web.calendar.editor.edit",
    state: "clean",
  },
  {
    id: "web.calendar.editor.edit.dirty",
    state: "dirty",
  },
  {
    id: "web.calendar.editor.edit.saving",
    state: "saving",
  },
  {
    id: "web.calendar.editor.edit.error",
    state: "error",
  },
  {
    id: "web.calendar.editor.edit.success",
    state: "success",
  },
  {
    id: "web.calendar.editor.discard",
    state: "dirty editor discard confirmation",
  },
  {
    id: "web.calendar.delete",
    state: "confirmation",
  },
  {
    id: "web.calendar.delete.applying",
    state: "applying",
  },
  {
    id: "web.calendar.delete.error",
    state: "error",
  },
  {
    id: "web.calendar.delete.success",
    state: "success",
  },
  {
    id: "web.calendar.recurrence-scope",
    state: "recurrence mutation scope choice",
  },
] as const;
