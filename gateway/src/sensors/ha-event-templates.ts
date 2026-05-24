import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "sensors", "ha-event-templates"]);

export interface HaState {
  state: string;
  attributes?: Record<string, unknown>;
}

export interface HaStateChanged {
  entity_id: string;
  old_state: HaState | null;
  new_state: HaState | null;
}

const SALIENCE_PREFIX = "sensor.ha";

function safeName(attributes: Record<string, unknown> | undefined): string {
  const raw = (attributes?.friendly_name as string) ?? "";
  if (!raw) return "unknown";
  return JSON.stringify(raw);
}

function domainOf(entityId: string): string {
  const dot = entityId.indexOf(".");
  return dot > 0 ? entityId.substring(0, dot) : entityId;
}

function stateOf(s: HaState | null): string {
  return s?.state ?? "unavailable";
}

function renderBinarySensor(name: string, oldState: string, newState: string): string {
  const verb = newState === "on" ? "triggered" : "cleared";
  return `${name} ${verb} (was ${oldState})`;
}

function renderOnOff(name: string, oldState: string, newState: string): string {
  const verb = newState === "on" ? "turned on" : "turned off";
  return `${name} ${verb} (was ${oldState})`;
}

function renderClimate(
  name: string,
  oldState: string,
  newState: string,
  attrs: Record<string, unknown> | undefined,
): string {
  const current = attrs?.current_temperature ?? attrs?.temperature;
  const target = attrs?.target_temp_high ?? attrs?.target_temperature;
  let extra = "";
  if (current != null) extra += ` current ${current}`;
  if (target != null) extra += ` target ${target}`;
  return `${name} HVAC ${oldState} → ${newState} (${extra.trim()})`;
}

function renderLock(name: string, newState: string): string {
  const verb = newState === "locked" ? "locked" : "unlocked";
  return `${name} ${verb}`;
}

function renderCover(name: string, newState: string): string {
  const verb = newState === "open" ? "open" : "closed";
  return `${name} ${verb}`;
}

function renderDefault(name: string, oldState: string, newState: string): string {
  return `${name} ${oldState} → ${newState}`;
}

export function salienceKeyFor(entityId: string): string {
  return `${SALIENCE_PREFIX}.${domainOf(entityId)}`;
}

export function renderHaEventSummary(evt: HaStateChanged): string {
  const domain = domainOf(evt.entity_id);
  const oldState = stateOf(evt.old_state);
  const newState = stateOf(evt.new_state);
  const attrs = evt.new_state?.attributes ?? evt.old_state?.attributes;
  const name = safeName(attrs);

  let summary: string;
  switch (domain) {
    case "binary_sensor":
      summary = renderBinarySensor(name, oldState, newState);
      break;
    case "light":
    case "switch":
      summary = renderOnOff(name, oldState, newState);
      break;
    case "climate":
      summary = renderClimate(name, oldState, newState, attrs);
      break;
    case "lock":
      summary = renderLock(name, newState);
      break;
    case "cover":
      summary = renderCover(name, newState);
      break;
    case "alarm_control_panel":
      summary = `${name} alarm ${newState}`;
      break;
    default:
      summary = renderDefault(name, oldState, newState);
  }

  log.debug("renderHaEventSummary", { entity_id: evt.entity_id, summary });
  return summary;
}
