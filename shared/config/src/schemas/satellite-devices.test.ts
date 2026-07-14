import { describe, expect, it } from "vitest";
import { satelliteDeviceSchema, satelliteDevicesSchema } from "./satellite-devices.js";

describe("satelliteDeviceSchema", () => {
  it("accepts a valid device", () => {
    const result = satelliteDeviceSchema.parse({
      device_id: "sat-kitchen-001",
      default_user: "family",
      location: "kitchen",
      speak_voice: "family_default_voice",
    });
    expect(result.device_id).toBe("sat-kitchen-001");
    expect(result.default_user).toBe("family");
    expect(result.location).toBe("kitchen");
    expect(result.speak_voice).toBe("family_default_voice");
  });

  it("rejects empty device_id", () => {
    expect(() =>
      satelliteDeviceSchema.parse({
        device_id: "",
        default_user: "family",
        location: "kitchen",
        speak_voice: "family_default_voice",
      }),
    ).toThrow();
  });

  it("rejects missing fields", () => {
    expect(() => satelliteDeviceSchema.parse({ device_id: "x" })).toThrow();
  });
});

describe("satelliteDevicesSchema", () => {
  it("defaults to empty array when absent", () => {
    const result = satelliteDevicesSchema.parse(undefined);
    expect(result).toEqual([]);
  });

  it("accepts an array of devices", () => {
    const input = [
      { device_id: "sat-1", default_user: "alice", location: "bedroom", speak_voice: "v1" },
      { device_id: "sat-2", default_user: "bob", location: "office", speak_voice: "v2" },
    ];
    const result = satelliteDevicesSchema.parse(input);
    expect(result).toHaveLength(2);
    expect(result[0]?.device_id).toBe("sat-1");
  });
});
