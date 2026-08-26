import { createHash } from "node:crypto";

/**
 * Capture IDs are opaque client input and may contain credentials or user
 * content. Logs use only this bounded one-way fingerprint so an operator can
 * correlate transitions without retaining the wire value.
 */
export function captureDiagnosticRef(captureId: string): string;
export function captureDiagnosticRef(captureId: null | undefined): null;
export function captureDiagnosticRef(captureId: string | null | undefined): string | null;
export function captureDiagnosticRef(captureId: string | null | undefined): string | null {
  if (captureId === null || captureId === undefined) return null;
  return `cap-${createHash("sha256").update(captureId).digest("hex").slice(0, 12)}`;
}
