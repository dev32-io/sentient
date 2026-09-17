import type { UserId } from "../user-auth/user-id.js";
import type { Capability } from "./capability.js";

export class PushResourceAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushResourceAuthorityError";
  }
}

/** Capability-held handle for one account's native installations and preferences. */
export class PrivatePushResource {
  readonly ownerUserId: UserId;
  readonly rootPath: string;

  constructor(capability: Capability) {
    if (capability.resource !== "push-private")
      throw new PushResourceAuthorityError(`expected push-private capability, got ${capability.resource}`);
    this.ownerUserId = capability.ownerUserId;
    this.rootPath = capability.rootPath;
    Object.freeze(this);
  }

  assertOwner(ownerUserId: UserId): void {
    if (ownerUserId !== this.ownerUserId) throw new PushResourceAuthorityError("push owner is outside capability");
  }
}
