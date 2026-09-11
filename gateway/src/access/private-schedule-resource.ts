import type { UserId } from "../user-auth/user-id.js";
import type { Capability } from "./capability.js";

export class ScheduleResourceAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleResourceAuthorityError";
  }
}

/** Capability-held handle for one user's schedules/cards; no principal lookup or household widening. */
export class PrivateScheduleResource {
  readonly ownerUserId: UserId;
  readonly rootPath: string;

  constructor(capability: Capability) {
    if (capability.resource !== "schedule-private")
      throw new ScheduleResourceAuthorityError(`expected schedule-private capability, got ${capability.resource}`);
    this.ownerUserId = capability.ownerUserId;
    this.rootPath = capability.rootPath;
    Object.freeze(this);
  }

  assertOwner(ownerUserId: UserId): void {
    if (ownerUserId !== this.ownerUserId)
      throw new ScheduleResourceAuthorityError("schedule owner is outside capability");
  }
}
