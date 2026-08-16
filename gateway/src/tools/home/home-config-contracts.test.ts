import { describe, expect, it } from "bun:test";
import {
  automationConfigSchema,
  calendarCreateSchema,
  calendarRemoveSchema,
  homeActionSchema,
  homeTriggerSchema,
  sceneConfigSchema,
  scriptConfigSchema,
  todoAddSchema,
  todoRemoveSchema,
  todoUpdateSchema,
} from "./home-config-contracts.js";

describe("native Home configuration contracts", () => {
  it("accepts bounded native scenes, script sequences, and routine automation constructs", () => {
    expect(
      sceneConfigSchema.safeParse({
        name: "Evening",
        entities: { "light.kitchen": { state: "on", attributes: { brightness: 100 } } },
      }).success,
    ).toBe(true);
    expect(
      scriptConfigSchema.safeParse({
        alias: "Bedtime",
        sequence: [{ action: "light.turn_off", target: { area_id: "downstairs" } }, { delay: "00:00:05" }],
      }).success,
    ).toBe(true);
    const triggers = [
      { platform: "time", at: "07:00:00" },
      { platform: "sun", event: "sunset" },
      { platform: "state", entity_id: "binary_sensor.door", to: "on" },
      { platform: "numeric_state", entity_id: "sensor.temperature", above: 25 },
      { platform: "event", event_type: "doorbell" },
      { platform: "device", device_id: "device_1", domain: "button", type: "pressed" },
      { platform: "zone", entity_id: "person.alex", zone: "zone.home", event: "enter" },
    ];
    expect(triggers.every((trigger) => homeTriggerSchema.safeParse(trigger).success)).toBe(true);
    expect(
      automationConfigSchema.safeParse({
        alias: "Arrival",
        trigger: triggers,
        condition: [{ condition: "state", entity_id: "input_boolean.guests", state: "off" }],
        action: [{ scene: "scene.evening" }],
      }).success,
    ).toBe(true);
    expect(
      automationConfigSchema.safeParse({
        alias: "Motion light",
        use_blueprint: { path: "homeassistant/motion_light.yaml", input: { motion_entity: "binary_sensor.motion" } },
      }).success,
    ).toBe(true);
  });

  it("rejects malformed, unbounded, and code-like configuration", () => {
    expect(sceneConfigSchema.safeParse({ name: "Empty", entities: {} }).success).toBe(false);
    expect(homeTriggerSchema.safeParse({ platform: "numeric_state", entity_id: "sensor.temp" }).success).toBe(false);
    expect(homeActionSchema.safeParse({ python: "open('/config/configuration.yaml')" }).success).toBe(false);
    expect(scriptConfigSchema.safeParse({ alias: "Unsafe", sequence: [{ action: "bad service" }] }).success).toBe(
      false,
    );
    expect(automationConfigSchema.safeParse({ alias: "YAML", yaml: "trigger: []" }).success).toBe(false);
  });

  it("pins todo and calendar write boundaries", () => {
    expect(todoAddSchema.safeParse({ list: "Groceries", summary: "Milk" }).success).toBe(true);
    expect(todoUpdateSchema.safeParse({ list: "Groceries", uid: "1", status: "completed" }).success).toBe(true);
    expect(todoRemoveSchema.safeParse({ list: "Groceries", uid: "1" }).success).toBe(true);
    expect(todoAddSchema.safeParse({ list: "Groceries", summary: "" }).success).toBe(false);
    expect(
      calendarCreateSchema.safeParse({
        calendar: "Family",
        summary: "Dinner",
        start: "2026-01-01T18:00:00Z",
        end: "2026-01-01T19:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      calendarCreateSchema.safeParse({
        calendar: "Family",
        summary: "Backwards",
        start: "2026-01-01T19:00:00Z",
        end: "2026-01-01T18:00:00Z",
      }).success,
    ).toBe(false);
    expect(calendarRemoveSchema.safeParse({ calendar: "Family", uid: "event-1" }).success).toBe(true);
  });
});
