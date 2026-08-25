(() => {
  const app = document.querySelector("[data-calendar-app]");
  if (!app) return;

  const TODAY = "2026-04-18";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const VIEW_DESCRIPTIONS = {
    day: "A focused agenda with room for what changes next.",
    week: "Seven days of household commitments at a glance.",
    month: "Your household calendar in one place.",
    year: "Yearly patterns and family milestones."
  };

  let events = [
    { id: "evt-routine", revision: 4, occurrenceId: "occ-routine-13", originalStart: "2026-04-13T07:00", recurring: true, scope: "household", title: "Monday morning routine", description: "Breakfast, bags, and departure checks.", start: "2026-04-13T07:00", end: "2026-04-13T08:00", visibility: "everyone", importance: "normal", group: "Routines", tags: ["morning", "school"], recurrence: "Weekly · Monday" },
    { id: "evt-appointment", revision: 2, occurrenceId: "occ-appointment-15", originalStart: "2026-04-15T15:00", recurring: false, scope: "private", title: "Jordan’s appointment", description: "Private appointment details remain visible only within the authorized calendar.", start: "2026-04-15T15:00", end: "2026-04-15T16:00", visibility: "adults", importance: "important", group: "Appointments", tags: ["health"] },
    { id: "evt-pickup", revision: 7, occurrenceId: "occ-pickup-18", originalStart: "2026-04-18T15:40", recurring: true, scope: "household", title: "School pickup", description: "Pickup at the east entrance.", start: "2026-04-18T15:40", end: "2026-04-18T16:00", visibility: "everyone", importance: "pinned", group: "School", tags: ["school", "pickup"], recurrence: "Weekly · Monday, Tuesday, Wednesday, Thursday, Friday" },
    { id: "evt-planning", revision: 3, occurrenceId: "occ-planning-18", originalStart: "2026-04-18T10:30", recurring: false, scope: "household", title: "Birthday planning", description: "Review the guest list and remaining preparations.", start: "2026-04-18T10:30", end: "2026-04-18T11:30", visibility: "adults", importance: "important", group: "Family", tags: ["family", "planning"] },
    { id: "evt-dinner", revision: 1, occurrenceId: "occ-dinner-18", originalStart: "2026-04-18T18:00", recurring: false, scope: "household", title: "Family dinner", description: "Dinner at home.", start: "2026-04-18T18:00", end: "2026-04-18T19:00", visibility: "everyone", importance: "normal", group: "Family", tags: ["family"] },
    { id: "evt-library", revision: 1, occurrenceId: "occ-library-18", originalStart: "2026-04-18T12:30", recurring: false, scope: "private", title: "Library returns", description: "Return borrowed books before closing.", start: "2026-04-18T12:30", end: "2026-04-18T13:00", visibility: "everyone", importance: "normal", group: "Errands", tags: ["errands"] },
    { id: "evt-call", revision: 1, occurrenceId: "occ-call-18", originalStart: "2026-04-18T14:00", recurring: false, scope: "private", title: "Call the contractor", description: "Confirm the revised arrival window.", start: "2026-04-18T14:00", end: "2026-04-18T14:20", visibility: "adults", importance: "normal", group: "Home", tags: ["home"] },
    { id: "evt-quiet", revision: 5, occurrenceId: "occ-quiet-19", originalStart: "2026-04-19", recurring: true, scope: "household", title: "Sunday quiet time", description: "A low-key morning at home.", start: "2026-04-19", end: null, allDay: true, visibility: "everyone", importance: "normal", group: "Routines", tags: ["routine"], recurrence: "Weekly · Sunday" },
    { id: "evt-arrival", revision: 2, occurrenceId: "occ-arrival-25", originalStart: "2026-04-25T18:30", recurring: false, scope: "household", title: "Elena arrives", description: "Arrival window from the latest itinerary.", start: "2026-04-25T18:30", end: "2026-04-25T19:00", visibility: "everyone", importance: "important", group: "Travel", tags: ["travel"] },
    { id: "evt-january", revision: 1, occurrenceId: "occ-january", originalStart: "2026-01-09T17:00", recurring: false, scope: "household", title: "Winter recital", description: "School auditorium.", start: "2026-01-09T17:00", end: "2026-01-09T19:00", visibility: "everyone", importance: "pinned", group: "School", tags: ["school"] },
    { id: "evt-july", revision: 1, occurrenceId: "occ-july", originalStart: "2026-07-12", recurring: false, scope: "household", title: "Family trip", description: "First travel day.", start: "2026-07-12", end: null, allDay: true, visibility: "everyone", importance: "important", group: "Travel", tags: ["travel"] },
    { id: "evt-october", revision: 1, occurrenceId: "occ-october", originalStart: "2026-10-03T09:00", recurring: false, scope: "private", title: "Home inspection", description: "Annual inspection appointment.", start: "2026-10-03T09:00", end: "2026-10-03T10:30", visibility: "adults", importance: "normal", group: "Home", tags: ["home"] }
  ];

  const state = {
    view: "month",
    anchor: TODAY,
    selectedDate: TODAY,
    scopes: new Set(["private", "household"]),
    groups: new Set(),
    tags: new Set(),
    importance: new Set(),
    search: "",
    filtersOpen: false,
    previewEventId: null,
    editingEventId: null,
    deleteEventId: null
  };

  const stage = document.querySelector("[data-calendar-stage]");
  const filterPanel = document.querySelector("[data-calendar-filters]");
  const scrim = document.querySelector("[data-calendar-scrim]");
  const preview = document.querySelector("[data-event-preview]");
  const overflowDialog = document.querySelector("[data-overflow-dialog]");
  const editor = document.querySelector("[data-event-editor]");
  const deleteDialog = document.querySelector("[data-delete-dialog]");
  let previewTrigger = null;
  let toastTimer = 0;

  const pad = (value) => String(value).padStart(2, "0");
  const dateFrom = (value) => new Date(`${value.slice(0, 10)}T12:00:00`);
  const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const addDays = (value, count) => { const date = dateFrom(value); date.setDate(date.getDate() + count); return dateKey(date); };
  const addMonths = (value, count) => { const date = dateFrom(value); date.setDate(1); date.setMonth(date.getMonth() + count); return dateKey(date); };
  const startOfWeek = (value) => { const date = dateFrom(value); date.setDate(date.getDate() - date.getDay()); return dateKey(date); };
  const eventDate = (event) => event.start.slice(0, 10);
  const escapeHtml = (value = "") => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const titleCase = (value) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : "";
  const formatDate = (value, options = {}) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
  const formatTime = (value) => {
    if (!value || value.length <= 10) return "All day";
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)).toLowerCase();
  };
  const formatWhen = (event) => {
    const date = formatDate(event.start, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    if (event.allDay || event.start.length <= 10) return `All day · ${date}`;
    const end = event.end ? ` – ${formatTime(event.end)}` : "";
    return `${date} · ${formatTime(event.start)}${end}`;
  };
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const importanceColor = (importance) => importance === "pinned" ? "var(--color-accent)" : importance === "important" ? "var(--color-amber)" : "var(--color-sage)";

  function filteredEvents() {
    const query = state.search.trim().toLowerCase();
    return events.filter((event) => {
      if (!state.scopes.has(event.scope)) return false;
      if (state.groups.size && !state.groups.has(event.group || "")) return false;
      if (state.tags.size && !event.tags.some((tag) => state.tags.has(tag))) return false;
      if (state.importance.size && !state.importance.has(event.importance)) return false;
      if (query && !`${event.title} ${event.description || ""}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }

  const facetValues = (key) => [...new Set(events.flatMap((event) => key === "tags" ? event.tags : event[key] ? [event[key]] : []))].sort();
  const facetCount = (key, value) => events.filter((event) => key === "tags" ? event.tags.includes(value) : event[key] === value).length;

  function filterChip(kind, value, label, count, selected, color = "") {
    return `<button class="snt-chip" type="button" aria-pressed="${selected}" data-filter-chip="${kind}" data-filter-value="${escapeHtml(value)}">${color ? `<i class="calendar-filter-dot" style="--importance-color:${color}"></i>` : ""}<span>${escapeHtml(label)}</span><small>${count}</small></button>`;
  }

  function activeFilterCount() {
    return (state.scopes.size === 2 ? 0 : 1) + state.groups.size + state.tags.size + state.importance.size + (state.search ? 1 : 0);
  }

  function renderFilters() {
    const importanceRoot = document.querySelector("[data-importance-options]");
    const groupRoot = document.querySelector("[data-group-options]");
    const tagRoot = document.querySelector("[data-tag-options]");
    importanceRoot.innerHTML = ["normal", "important", "pinned"].map((value) => filterChip("importance", value, titleCase(value), facetCount("importance", value), state.importance.has(value), importanceColor(value))).join("");
    groupRoot.innerHTML = facetValues("group").map((value) => filterChip("groups", value, value, facetCount("group", value), state.groups.has(value))).join("");
    tagRoot.innerHTML = facetValues("tags").map((value) => filterChip("tags", value, value, facetCount("tags", value), state.tags.has(value))).join("");
    ["private", "household"].forEach((scope) => {
      const input = document.querySelector(`[data-scope][value="${scope}"]`);
      if (input) input.checked = state.scopes.has(scope);
      const count = document.querySelector(`[data-scope-count="${scope}"]`);
      if (count) count.textContent = String(events.filter((event) => event.scope === scope).length);
    });
    const selectedLabel = (size) => size ? `${size} selected` : "None selected";
    document.querySelector("[data-group-filter-count]").textContent = selectedLabel(state.groups.size);
    document.querySelector("[data-tag-filter-count]").textContent = selectedLabel(state.tags.size);
    const count = activeFilterCount();
    const summary = document.querySelector("[data-filter-count]");
    if (summary) summary.textContent = count ? `${count} active ${count === 1 ? "filter" : "filters"}` : "No active filters";
    const clear = document.querySelector("[data-clear-filters]");
    if (clear) clear.disabled = count === 0;
    const badge = document.querySelector("[data-active-filter-badge]");
    if (badge) badge.hidden = count === 0;
    const search = document.querySelector("[data-calendar-search]");
    if (search && search.value !== state.search) search.value = state.search;
    window.SentientComponents?.enhance(filterPanel);
  }

  function periodLabel() {
    const anchor = dateFrom(state.anchor);
    if (state.view === "day") return formatDate(state.anchor, { weekday: "long", month: "long", day: "numeric" });
    if (state.view === "week") {
      const start = startOfWeek(state.anchor);
      const end = addDays(start, 6);
      return `${formatDate(start, { month: "short", day: "numeric" })} – ${formatDate(end, { month: "short", day: "numeric", year: "numeric" })}`;
    }
    if (state.view === "year") return String(anchor.getFullYear());
    return `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`;
  }

  function eventButton(event, compact = false) {
    const time = formatTime(event.start);
    return `<button class="calendar-event${compact ? " is-compact" : ""}" type="button" data-event-id="${event.id}" data-importance="${event.importance}" aria-label="${escapeHtml(`${event.title}, ${time}`)}" aria-haspopup="dialog"><span class="calendar-event__time">${escapeHtml(time)}</span><span class="calendar-event__title">${escapeHtml(event.title)}</span></button>`;
  }

  function renderMonth(list) {
    const anchor = dateFrom(state.anchor);
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    let html = `<div class="calendar-month" role="grid" aria-label="${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}">${WEEKDAYS.map((day) => `<div class="calendar-weekday" role="columnheader">${day.slice(0, 3)}</div>`).join("")}`;
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = dateKey(date);
      const cellEvents = list.filter((event) => eventDate(event) === key).sort((a, b) => a.start.localeCompare(b.start));
      const eventLimit = window.innerWidth <= 620 ? 2 : stage.clientHeight >= 900 ? 3 : stage.clientHeight >= 720 ? 2 : 1;
      const visible = cellEvents.slice(0, eventLimit);
      const overflow = cellEvents.slice(eventLimit);
      const classes = ["calendar-day-cell", date.getMonth() !== anchor.getMonth() ? "is-outside" : "", key === state.selectedDate ? "is-selected" : "", key === TODAY ? "is-today" : ""].filter(Boolean).join(" ");
      html += `<div class="${classes}" role="gridcell" aria-selected="${key === state.selectedDate}" data-date="${key}"><button class="calendar-date-button" type="button" data-select-date="${key}" aria-label="Open ${escapeHtml(formatDate(key, { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}">${date.getDate()}</button><div class="calendar-cell-events">${visible.map((event) => eventButton(event)).join("")}${overflow.length ? `<button class="calendar-overflow" type="button" data-overflow-date="${key}" aria-label="${overflow.length} more events on ${escapeHtml(formatDate(key, { month: "long", day: "numeric" }))}"><span>+${overflow.length}</span><span class="calendar-overflow__suffix"> more</span></button>` : ""}</div></div>`;
    }
    return `${html}</div>`;
  }

  function agendaRow(event) {
    const scopeIcon = event.scope === "private" ? "lock" : "home";
    return `<button class="calendar-agenda-row" type="button" data-event-id="${event.id}" data-importance="${event.importance}" aria-haspopup="dialog"><time class="calendar-agenda-row__time">${escapeHtml(formatTime(event.start))}</time><i class="calendar-agenda-row__marker" aria-hidden="true"></i><span class="calendar-agenda-row__copy"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.description || (event.allDay ? "All-day event" : event.group || "Calendar event"))}</small></span><span class="calendar-agenda-row__scope" aria-label="${titleCase(event.scope)}">${icon(scopeIcon)}</span></button>`;
  }

  function renderDay(list) {
    const dayEvents = list.filter((event) => eventDate(event) === state.anchor).sort((a, b) => a.start.localeCompare(b.start));
    return `<section class="calendar-agenda"><header class="calendar-agenda-head"><div><h3>${escapeHtml(formatDate(state.anchor, { weekday: "long", month: "long", day: "numeric" }))}</h3><p>${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}</p></div></header>${dayEvents.length ? `<div class="calendar-agenda-list">${dayEvents.map(agendaRow).join("")}</div>` : `<div class="calendar-empty"><strong>No events this day</strong><p>Choose another date or adjust the filters.</p></div>`}</section>`;
  }

  function renderWeek(list) {
    const start = startOfWeek(state.anchor);
    let html = `<div class="calendar-week" role="grid" aria-label="Week of ${escapeHtml(formatDate(start, { month: "long", day: "numeric" }))}">`;
    for (let index = 0; index < 7; index += 1) {
      const key = addDays(start, index);
      const dayEvents = list.filter((event) => eventDate(event) === key).sort((a, b) => a.start.localeCompare(b.start));
      html += `<section class="calendar-week-column${key === state.selectedDate ? " is-selected" : ""}" role="gridcell"><header><button class="calendar-date-button" type="button" data-select-date="${key}" aria-label="Open ${escapeHtml(formatDate(key, { weekday: "long", month: "long", day: "numeric" }))}">${dateFrom(key).getDate()}</button><strong>${WEEKDAYS[dateFrom(key).getDay()]}</strong><span>${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}</span></header><div class="calendar-cell-events">${dayEvents.map((event) => eventButton(event, true)).join("")}</div></section>`;
    }
    return `${html}</div>`;
  }

  function renderYear(list) {
    const year = dateFrom(state.anchor).getFullYear();
    return `<div class="calendar-year">${MONTHS.map((month, monthIndex) => {
      const monthEvents = list.filter((event) => { const date = dateFrom(event.start); return date.getFullYear() === year && date.getMonth() === monthIndex; });
      const markedDays = new Map(monthEvents.map((event) => [dateFrom(event.start).getDate(), event.importance]));
      const dots = Array.from({ length: 35 }, (_, index) => { const importance = markedDays.get(index + 1); return `<i class="${importance ? importance === "pinned" ? "has-pinned" : "has-event" : ""}"></i>`; }).join("");
      return `<button class="calendar-year-month" type="button" data-select-month="${monthIndex}"><h3>${month}</h3><p>${monthEvents.length} ${monthEvents.length === 1 ? "event" : "events"}</p><span class="year-mini-grid" aria-hidden="true">${dots}</span></button>`;
    }).join("")}</div>`;
  }

  function renderCalendar() {
    const list = filteredEvents();
    document.querySelector("[data-calendar-period]").textContent = periodLabel();
    document.querySelector("[data-view-description]").textContent = VIEW_DESCRIPTIONS[state.view];
    document.querySelectorAll("[data-calendar-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.calendarView === state.view)));
    stage.dataset.view = state.view;
    stage.innerHTML = state.view === "day" ? renderDay(list) : state.view === "week" ? renderWeek(list) : state.view === "year" ? renderYear(list) : renderMonth(list);
    const notice = document.querySelector("[data-calendar-notice]");
    const total = list.length;
    notice.hidden = total > 0 || activeFilterCount() === 0;
    if (!notice.hidden) notice.textContent = "No events match the current filters. Saved calendar data is unchanged.";
    renderFilters();
    window.SentientComponents?.enhance(document);
  }

  function closeFilters() {
    state.filtersOpen = false;
    filterPanel.classList.remove("is-open");
    document.querySelector("[data-filter-open]")?.setAttribute("aria-expanded", "false");
    syncScrim();
  }

  function openFilters() {
    state.filtersOpen = true;
    filterPanel.classList.add("is-open");
    document.querySelector("[data-filter-open]")?.setAttribute("aria-expanded", "true");
    syncScrim();
    filterPanel.querySelector("input, button")?.focus();
  }

  function syncScrim() {
    scrim.hidden = !(state.filtersOpen || !preview.hidden);
  }

  function previewDetails(event) {
    const details = [
      ["When", formatWhen(event)],
      ...(event.start.length > 10 ? [["Timezone", "Device local"]] : []),
      ["Scope", titleCase(event.scope)],
      ["Visibility", event.visibility === "adults" ? "Adults only" : "Everyone"],
      ["Importance", titleCase(event.importance)],
      ...(event.group ? [["Group", event.group]] : []),
      ...(event.tags.length ? [["Tags", event.tags.join(", ")]] : []),
      ...(event.recurring ? [["Recurrence", event.recurrence || "Repeating"]] : [])
    ];
    return details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  }

  function openPreview(eventId, trigger) {
    const event = events.find((item) => item.id === eventId);
    if (!event) return;
    closeFilters();
    state.previewEventId = event.id;
    previewTrigger = trigger || null;
    preview.querySelector("[data-preview-title]").textContent = event.title;
    preview.querySelector("[data-preview-time]").textContent = formatWhen(event);
    const description = preview.querySelector("[data-preview-description]");
    description.textContent = event.description || "";
    description.hidden = !event.description;
    preview.querySelector("[data-preview-details]").innerHTML = previewDetails(event);
    preview.hidden = false;
    if (window.innerWidth > 620 && trigger) {
      const rect = trigger.getBoundingClientRect();
      const width = 380;
      let left = rect.right + 12;
      if (left + width > window.innerWidth - 12) left = Math.max(12, rect.left - width - 12);
      const top = Math.max(12, Math.min(rect.top - 22, window.innerHeight - Math.min(620, preview.scrollHeight) - 12));
      preview.style.left = `${left}px`;
      preview.style.top = `${top}px`;
      preview.style.right = "auto";
      preview.style.bottom = "auto";
    } else {
      preview.removeAttribute("style");
    }
    syncScrim();
    preview.querySelector("[data-preview-close]")?.focus();
  }

  function closePreview(restore = true) {
    if (preview.hidden) return;
    preview.hidden = true;
    state.previewEventId = null;
    preview.removeAttribute("style");
    syncScrim();
    if (restore) previewTrigger?.focus();
    previewTrigger = null;
  }

  function openOverflow(date) {
    const dateEvents = filteredEvents().filter((event) => eventDate(event) === date).sort((a, b) => a.start.localeCompare(b.start));
    overflowDialog.querySelector("[data-overflow-title]").textContent = formatDate(date, { weekday: "long", month: "long", day: "numeric" });
    overflowDialog.querySelector("[data-overflow-list]").innerHTML = dateEvents.map((event) => `<button type="button" data-overflow-event="${event.id}" style="--importance-color:${importanceColor(event.importance)}"><i aria-hidden="true"></i><span><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.description || event.group || "Calendar event")}</small></span><time>${escapeHtml(formatTime(event.start))}</time></button>`).join("");
    overflowDialog.showModal();
  }

  function defaultEditorDate() {
    return `${state.selectedDate}T09:00`;
  }

  function openEditor(eventId = null) {
    closePreview(false);
    const event = eventId ? events.find((item) => item.id === eventId) : null;
    state.editingEventId = event?.id || null;
    const form = editor.querySelector("[data-event-form]");
    form.reset();
    editor.querySelector("[data-editor-title]").textContent = event ? "Edit event" : "Add event";
    form.elements.title.value = event?.title || "";
    form.elements.description.value = event?.description || "";
    form.elements.allDay.checked = Boolean(event?.allDay);
    form.elements.start.value = event?.allDay ? event.start : event?.start || defaultEditorDate();
    form.elements.end.value = event?.allDay ? event.end || "" : event?.end || `${state.selectedDate}T10:00`;
    form.elements.scope.value = event?.scope || "private";
    form.elements.visibility.value = event?.visibility || "everyone";
    form.elements.importance.value = event?.importance || "normal";
    form.elements.group.value = event?.group || "";
    form.elements.tags.value = event?.tags.join(", ") || "";
    form.elements.recurrence.value = event?.recurring ? (event.recurrence || "weekly").split(" ")[0].toLowerCase() : "none";
    const mutation = editor.querySelector("[data-mutation-scope]");
    mutation.hidden = !(event?.recurring);
    syncAllDayInputs();
    editor.showModal();
    form.elements.title.focus();
  }

  function syncAllDayInputs() {
    const form = editor.querySelector("[data-event-form]");
    const allDay = form.elements.allDay.checked;
    [form.elements.start, form.elements.end].forEach((input) => {
      const date = input.value.slice(0, 10) || state.selectedDate;
      input.type = allDay ? "date" : "datetime-local";
      input.value = allDay ? date : `${date}T${input.name === "start" ? "09:00" : "10:00"}`;
    });
  }

  function saveEditor() {
    const form = editor.querySelector("[data-event-form]");
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const recurrence = data.get("recurrence");
    const allDay = form.elements.allDay.checked;
    const existing = events.find((event) => event.id === state.editingEventId);
    const id = existing?.id || `evt-${Date.now()}`;
    const next = {
      id,
      revision: (existing?.revision || 0) + 1,
      occurrenceId: existing?.occurrenceId || `occ-${Date.now()}`,
      originalStart: existing?.originalStart || String(data.get("start")),
      recurring: recurrence !== "none",
      scope: String(data.get("scope")),
      title: String(data.get("title")).trim(),
      description: String(data.get("description")).trim(),
      start: String(data.get("start")),
      end: String(data.get("end")) || null,
      allDay,
      visibility: String(data.get("visibility")),
      importance: String(data.get("importance")),
      group: String(data.get("group")).trim() || undefined,
      tags: String(data.get("tags")).split(",").map((tag) => tag.trim()).filter(Boolean),
      ...(recurrence !== "none" ? { recurrence: titleCase(String(recurrence)) } : {})
    };
    events = existing ? events.map((event) => event.id === id ? next : event) : [...events, next];
    state.selectedDate = eventDate(next);
    state.anchor = state.selectedDate;
    editor.close();
    state.editingEventId = null;
    renderCalendar();
    showToast(existing ? "Event saved" : "Event added");
  }

  function openDelete(eventId) {
    closePreview(false);
    const event = events.find((item) => item.id === eventId);
    if (!event) return;
    state.deleteEventId = event.id;
    const field = deleteDialog.querySelector("[data-delete-scope]").closest("label");
    field.hidden = !event.recurring;
    deleteDialog.showModal();
    deleteDialog.querySelector("[data-delete-cancel]").focus();
  }

  function showToast(message) {
    const toast = document.querySelector("[data-calendar-toast]");
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2200);
  }

  function navigate(direction) {
    if (state.view === "day") state.anchor = addDays(state.anchor, direction);
    else if (state.view === "week") state.anchor = addDays(state.anchor, direction * 7);
    else if (state.view === "year") state.anchor = addMonths(state.anchor, direction * 12);
    else state.anchor = addMonths(state.anchor, direction);
    renderCalendar();
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    const viewButton = target.closest("[data-calendar-view]");
    if (viewButton) { state.view = viewButton.dataset.calendarView; renderCalendar(); return; }
    if (target.closest("[data-calendar-previous]")) { navigate(-1); return; }
    if (target.closest("[data-calendar-next]")) { navigate(1); return; }
    if (target.closest("[data-calendar-today]")) { state.anchor = TODAY; state.selectedDate = TODAY; renderCalendar(); return; }
    if (target.closest("[data-filter-open]")) { openFilters(); return; }
    if (target.closest("[data-filter-close]")) { closeFilters(); return; }
    if (target.closest("[data-calendar-scrim]")) { closeFilters(); closePreview(); return; }
    const filterChip = target.closest("[data-filter-chip]");
    if (filterChip) {
      const set = state[filterChip.dataset.filterChip];
      const value = filterChip.dataset.filterValue;
      set.has(value) ? set.delete(value) : set.add(value);
      renderCalendar();
      return;
    }
    if (target.closest("[data-clear-filters]")) { state.scopes.clear(); state.scopes.add("private"); state.scopes.add("household"); state.groups.clear(); state.tags.clear(); state.importance.clear(); state.search = ""; renderCalendar(); return; }
    const dateButton = target.closest("[data-select-date]");
    if (dateButton) { state.selectedDate = dateButton.dataset.selectDate; state.anchor = state.selectedDate; state.view = "day"; renderCalendar(); showToast(`Showing ${formatDate(state.anchor, { month: "long", day: "numeric" })}`); return; }
    const monthButton = target.closest("[data-select-month]");
    if (monthButton) { const date = dateFrom(state.anchor); date.setMonth(Number(monthButton.dataset.selectMonth), 1); state.anchor = dateKey(date); state.view = "month"; renderCalendar(); return; }
    const eventButton = target.closest("[data-event-id]");
    if (eventButton) { openPreview(eventButton.dataset.eventId, eventButton); return; }
    const overflow = target.closest("[data-overflow-date]");
    if (overflow) { openOverflow(overflow.dataset.overflowDate); return; }
    const overflowEvent = target.closest("[data-overflow-event]");
    if (overflowEvent) { const id = overflowEvent.dataset.overflowEvent; overflowDialog.close(); requestAnimationFrame(() => openPreview(id, null)); return; }
    if (target.closest("[data-preview-close]")) { closePreview(); return; }
    if (target.closest("[data-preview-edit]")) { openEditor(state.previewEventId); return; }
    if (target.closest("[data-preview-delete]")) { openDelete(state.previewEventId); return; }
    if (target.closest("[data-add-event]")) { openEditor(); return; }
    if (target.closest("[data-editor-close], [data-editor-cancel]")) { editor.close(); state.editingEventId = null; return; }
    if (target.closest("[data-delete-cancel]")) { deleteDialog.close(); state.deleteEventId = null; return; }
    if (target.closest("[data-delete-confirm]")) { events = events.filter((item) => item.id !== state.deleteEventId); deleteDialog.close(); state.deleteEventId = null; renderCalendar(); showToast("Event deleted"); return; }
    if (target.closest("[data-dialog-close]")) { target.closest("dialog")?.close(); }
  });

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (input.matches("[data-scope]")) {
      input.checked ? state.scopes.add(input.value) : state.scopes.delete(input.value);
      renderCalendar();
      return;
    }
    if (input.matches("[data-filter-kind]")) {
      const set = state[input.dataset.filterKind];
      input.checked ? set.add(input.value) : set.delete(input.value);
      renderCalendar();
      return;
    }
    if (input.matches('[name="allDay"]')) syncAllDayInputs();
  });

  document.querySelector("[data-calendar-search]").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderCalendar();
    requestAnimationFrame(() => { const input = document.querySelector("[data-calendar-search]"); input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); });
  });

  editor.querySelector("[data-event-form]").addEventListener("submit", (event) => { event.preventDefault(); saveEditor(); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.filtersOpen) closeFilters();
    else if (!preview.hidden) closePreview();
  });
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (state.view === "month") renderCalendar();
      if (!preview.hidden) openPreview(state.previewEventId, previewTrigger);
    });
  });

  renderCalendar();
})();
