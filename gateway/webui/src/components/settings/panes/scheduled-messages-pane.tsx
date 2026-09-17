import type { JSX } from "preact";
import type { Schedule, ScheduleCreateRequest, ScheduleTimingInput } from "@sentient/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { useSchedules } from "../../../hooks/use-schedules.ts";
import { ActionButton, Field, SegmentedControl, SelectControl, TextArea, ToggleControl } from "../../common/foundation.tsx";
import { ActionRow, AsyncState, Notice, PaneChrome, SettingsCard, SettingsGroup, SettingsRow } from "../../common/composites.tsx";
import { useSettingsBusyState, useSettingsDraft } from "../navigation-state.ts";

const TIMING_OPTIONS = [
  { value: "once-at", label: "At a time" },
  { value: "once-after", label: "After a delay" },
  { value: "recurring", label: "Repeating" },
];
const FREQUENCY_OPTIONS = [
  { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" },
];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

type Kind = ScheduleTimingInput["kind"];
interface Draft { message: string; kind: Kind; at: string; afterMinutes: string; frequency: "daily" | "weekly" | "monthly"; localTime: string; weekday: typeof WEEKDAYS[number]; dayOfMonth: string; enabled: boolean }
const emptyDraft = (): Draft => ({ message: "", kind: "once-at", at: "", afterMinutes: "30", frequency: "daily", localTime: "09:00", weekday: "monday", dayOfMonth: "1", enabled: true });

function localDateTime(instant: string): string {
  const date = new Date(instant); if (!Number.isFinite(date.getTime())) return "";
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}
function draftFor(schedule: Schedule): Draft {
  if (schedule.timing.kind === "once") return { ...emptyDraft(), message: schedule.message, kind: "once-at", at: localDateTime(schedule.timing.at), enabled: schedule.enabled };
  return { ...emptyDraft(), message: schedule.message, kind: "recurring", frequency: schedule.timing.frequency, localTime: schedule.timing.localTime, weekday: schedule.timing.weekdays?.[0] ?? "monday", dayOfMonth: String(schedule.timing.dayOfMonth ?? 1), enabled: schedule.enabled };
}
function timingOf(draft: Draft, timeZone: string): ScheduleTimingInput | null {
  if (draft.kind === "once-at") {
    const date = new Date(draft.at); return Number.isFinite(date.getTime()) && date.getTime() > Date.now() ? { kind: "once-at", at: date.toISOString() } : null;
  }
  if (draft.kind === "once-after") {
    const minutes = Number(draft.afterMinutes); return Number.isFinite(minutes) && minutes > 0 ? { kind: "once-after", afterSeconds: Math.round(minutes * 60) } : null;
  }
  const base = { kind: "recurring" as const, frequency: draft.frequency, localTime: draft.localTime, timeZone };
  if (draft.frequency === "weekly") return { ...base, weekdays: [draft.weekday] };
  if (draft.frequency === "monthly") { const day = Number(draft.dayOfMonth); return Number.isInteger(day) && day >= 1 && day <= 31 ? { ...base, dayOfMonth: day } : null; }
  return base;
}
function formatRun(value: string | null): string { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "No next run"; }

export function ScheduledMessagesPane({ token }: { token: string }): JSX.Element {
  const state = useSchedules(token);
  const [editing, setEditing] = useState<Schedule | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [validation, setValidation] = useState<string | null>(null);
  const createKey = useRef(crypto.randomUUID());
  const [, setNavigationBusy] = useSettingsBusyState();
  useSettingsDraft(editing !== undefined);
  useEffect(() => {
    if (state.pendingId === null) return;
    setNavigationBusy(true);
    return () => setNavigationBusy(false);
  }, [state.pendingId, setNavigationBusy]);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const open = (schedule: Schedule | null) => { if (!schedule) createKey.current = crypto.randomUUID(); setEditing(schedule); setDraft(schedule ? draftFor(schedule) : emptyDraft()); setValidation(null); };
  const submit = async (event: Event) => {
    event.preventDefault(); const message = draft.message.trim(); const timing = timingOf(draft, zone);
    if (!message) { setValidation("Write the message Sentient should receive."); return; }
    if (!timing) { setValidation("Choose a valid future time or delay."); return; }
    const input: ScheduleCreateRequest = { idempotencyKey: createKey.current, message, timing, enabled: draft.enabled };
    if (await state.save(editing ?? null, input)) setEditing(undefined);
  };
  return <PaneChrome title="Scheduled messages" subtitle="Ask Sentient to start a private conversation once or on a repeating schedule.">
    {state.error && <Notice tone="error" title="Schedule change failed" action={<ActionButton variant="quiet" onClick={() => void state.refresh()}>Try again</ActionButton>}>{state.error.message}</Notice>}
    <SettingsCard title="Your schedules" action={<ActionButton variant="primary" onClick={() => open(null)}>New schedule</ActionButton>} padded={false}>
      {state.loading && state.schedules.length === 0 ? <AsyncState state="loading" title="Loading schedules" /> : state.schedules.length === 0 ? <AsyncState state="empty" title="No scheduled messages" message="Create one to continue a conversation at the right time." /> : <SettingsGroup>
        {state.schedules.map((schedule) => <SettingsRow key={schedule.scheduleId} label={schedule.message} hint={`${formatRun(schedule.nextRunAt)} · ${schedule.timing.kind === "recurring" ? `${schedule.timing.frequency} in ${schedule.timing.timeZone}` : "one time"}`}>
          <ActionRow><ToggleControl label={`${schedule.enabled ? "Pause" : "Resume"} schedule`} checked={schedule.enabled} disabled={state.pendingId === schedule.scheduleId} onChange={(enabled) => void state.setEnabled(schedule, enabled)} /><ActionButton variant="quiet" disabled={state.pendingId === schedule.scheduleId} onClick={() => open(schedule)}>Edit</ActionButton><ActionButton variant="destructive" disabled={state.pendingId === schedule.scheduleId} onClick={() => void state.remove(schedule)}>Delete</ActionButton></ActionRow>
        </SettingsRow>)}
      </SettingsGroup>}
    </SettingsCard>
    {editing !== undefined && <SettingsCard title={editing ? "Edit schedule" : "New schedule"} subtitle={`Times use ${zone}.`}>
      <form class="schedule-form" onSubmit={(event) => void submit(event)}>
        <TextArea label="Message" rows={3} maxLength={12000} value={draft.message} onInput={(event) => setDraft({ ...draft, message: event.currentTarget.value })} />
        <SegmentedControl label="Timing" value={draft.kind} options={TIMING_OPTIONS} onChange={(kind) => setDraft({ ...draft, kind: kind as Kind })} />
        {draft.kind === "once-at" && <Field label="Run at" type="datetime-local" required value={draft.at} onInput={(event) => setDraft({ ...draft, at: event.currentTarget.value })} />}
        {draft.kind === "once-after" && <Field label="Delay in minutes" type="number" inputMode="numeric" required value={draft.afterMinutes} onInput={(event) => setDraft({ ...draft, afterMinutes: event.currentTarget.value })} />}
        {draft.kind === "recurring" && <><SelectControl label="Repeat" value={draft.frequency} options={FREQUENCY_OPTIONS} onChange={(frequency) => setDraft({ ...draft, frequency: frequency as Draft["frequency"] })} /><Field label="Local time" type="time" required value={draft.localTime} onInput={(event) => setDraft({ ...draft, localTime: event.currentTarget.value })} />{draft.frequency === "weekly" && <SelectControl label="Weekday" value={draft.weekday} options={WEEKDAYS.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))} onChange={(weekday) => setDraft({ ...draft, weekday: weekday as Draft["weekday"] })} />}{draft.frequency === "monthly" && <Field label="Day of month" type="number" inputMode="numeric" value={draft.dayOfMonth} onInput={(event) => setDraft({ ...draft, dayOfMonth: event.currentTarget.value })} />}</>}
        <SettingsRow label="Enabled" hint="Paused schedules remain saved but do not run."><ToggleControl label="Schedule enabled" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} /></SettingsRow>
        {validation && <Notice tone="error">{validation}</Notice>}
        <ActionRow><ActionButton type="submit" variant="primary" disabled={state.pendingId !== null}>{state.pendingId ? "Saving…" : "Save schedule"}</ActionButton><ActionButton variant="quiet" disabled={state.pendingId !== null} onClick={() => setEditing(undefined)}>Cancel</ActionButton></ActionRow>
      </form>
    </SettingsCard>}
  </PaneChrome>;
}
