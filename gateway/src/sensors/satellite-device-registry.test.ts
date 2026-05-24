import type { SatelliteDevice } from "@sentient/config";
import { describe, expect, it } from "vitest";
import { createSatelliteDeviceRegistry } from "./satellite-device-registry.js";

const kitchen: SatelliteDevice = {
  device_id: "sat-kitchen-001",
  default_user: "family",
  location: "kitchen",
  speak_voice: "fish_family_default",
};

const aliceBed: SatelliteDevice = {
  device_id: "sat-alice-bed-002",
  default_user: "alice",
  location: "alice-bed",
  speak_voice: "fish_alice",
};

describe("SatelliteDeviceRegistry", () => {
  it("resolves a known device id", () => {
    const registry = createSatelliteDeviceRegistry([kitchen, aliceBed]);
    const result = registry.resolve("sat-kitchen-001");
    expect(result).toEqual(kitchen);
  });

  it("returns null for an unknown device id", () => {
    const registry = createSatelliteDeviceRegistry([kitchen, aliceBed]);
    const result = registry.resolve("sat-unknown-999");
    expect(result).toBeNull();
  });

  it("list returns all registered devices", () => {
    const registry = createSatelliteDeviceRegistry([kitchen, aliceBed]);
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all).toEqual([kitchen, aliceBed]);
  });

  it("works with an empty device list", () => {
    const registry = createSatelliteDeviceRegistry([]);
    expect(registry.resolve("any-id")).toBeNull();
    expect(registry.list()).toEqual([]);
  });
});
