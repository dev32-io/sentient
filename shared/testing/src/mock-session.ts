import type { UserRole } from "@sentient/protocol";

export interface MockSession {
  sessionId: string;
  userId: string;
  role: UserRole;
  deviceId: string;
  createdAt: number;
  abortController: AbortController;
}

export function createMockSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    userId: "user-1",
    role: "adult",
    deviceId: "device-1",
    createdAt: Date.now(),
    abortController: new AbortController(),
    ...overrides,
  };
}
