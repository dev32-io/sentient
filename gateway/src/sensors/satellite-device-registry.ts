import type { SatelliteDevice } from "@sentient/config";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "sensors", "satellite-device-registry"]);

export interface SatelliteDeviceRegistry {
  resolve(deviceId: string): SatelliteDevice | null;
  list(): readonly SatelliteDevice[];
}

export function createSatelliteDeviceRegistry(devices: SatelliteDevice[]): SatelliteDeviceRegistry {
  const byId = new Map(devices.map((d) => [d.device_id, d]));
  log.debug("init", { count: devices.length });
  return {
    resolve(deviceId) {
      return byId.get(deviceId) ?? null;
    },
    list() {
      return devices;
    },
  };
}
