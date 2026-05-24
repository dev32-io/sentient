import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "key-rotation"]);

export interface RotationStatus {
  active: boolean;
  current_user: string | null;
  completed: number;
  total: number;
  failures: Array<{ userId: string; reason: string }>;
}

export interface KeyRotationOrchestrator {
  rotate(): Promise<void>;
  status(): RotationStatus;
}

export interface KeyRotationDeps {
  listUsers: () => Promise<string[]>;
  reprovisionUser: (userId: string) => Promise<{ ok: boolean; reason?: string }>;
}

export function createKeyRotation(deps: KeyRotationDeps): KeyRotationOrchestrator {
  let rotationStatus: RotationStatus = {
    active: false,
    current_user: null,
    completed: 0,
    total: 0,
    failures: [],
  };
  let running: Promise<void> | null = null;

  async function loop(): Promise<void> {
    const users = await deps.listUsers();
    rotationStatus = { active: true, current_user: null, completed: 0, total: users.length, failures: [] };
    log.info("key-rotation.start", { total: users.length });

    for (const userId of users) {
      rotationStatus = { ...rotationStatus, current_user: userId };
      const r = await deps.reprovisionUser(userId);
      if (!r.ok) {
        const reason = r.reason ?? "unknown";
        rotationStatus = { ...rotationStatus, failures: [...rotationStatus.failures, { userId, reason }] };
        log.warn("key-rotation.user-failed", { userId, reason });
      }
      rotationStatus = { ...rotationStatus, completed: rotationStatus.completed + 1 };
    }

    rotationStatus = { ...rotationStatus, active: false, current_user: null };
    log.info("key-rotation.done", { failures: rotationStatus.failures.length });
  }

  return {
    async rotate() {
      if (running) return running;
      running = loop().finally(() => {
        running = null;
      });
      return running;
    },
    status() {
      return rotationStatus;
    },
  };
}
