import { z } from "zod";

/** Satellite device binding — maps a deviceId to default user, location, TTS voice. */
export const satelliteDeviceSchema = z.object({
  device_id: z.string().min(1),
  default_user: z.string().min(1),
  location: z.string().min(1),
  speak_voice: z.string().min(1),
});
export type SatelliteDevice = z.infer<typeof satelliteDeviceSchema>;

/** Array of satellite devices, defaulting to empty when absent. */
export const satelliteDevicesSchema = z.array(satelliteDeviceSchema).default([]);
