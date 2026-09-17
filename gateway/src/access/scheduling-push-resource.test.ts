import { describe, expect, it } from "vitest";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { UserId } from "../user-auth/user-id.js";
import { createAccessManager } from "./access-manager.js";
import { PrivatePushResource } from "./private-push-resource.js";
import { PrivateScheduleResource } from "./private-schedule-resource.js";

const access = createAccessManager({ userDataRoot: "/tmp/sentient-boundary-users" });
const alice = createUserPrincipal("u_a11ce001" as UserId, "adult", "household");
const bobId = "u_b0b00001" as UserId;
const bob = createUserPrincipal(bobId, "adult", "household");

describe("private scheduling/push capability confinement", () => {
  it("rejects cross-resource capabilities even when their owner and path are identical", () => {
    const scheduleCap = access.grant(alice, "schedule-private");
    const pushCap = access.grant(alice, "push-private");
    expect(() => new PrivateScheduleResource(pushCap)).toThrow(/schedule-private/);
    expect(() => new PrivatePushResource(scheduleCap)).toThrow(/push-private/);
  });

  it("rejects references owned by another user without consulting ambient identity", () => {
    const schedules = new PrivateScheduleResource(access.grant(alice, "schedule-private"));
    const push = new PrivatePushResource(access.grant(alice, "push-private"));
    expect(() => schedules.assertOwner(bobId)).toThrow(/outside capability/);
    expect(() => push.assertOwner(bobId)).toThrow(/outside capability/);
    expect(() => schedules.assertOwner(alice.userId)).not.toThrow();
    expect(() => push.assertOwner(alice.userId)).not.toThrow();
    expect(schedules.rootPath).not.toBe(new PrivateScheduleResource(access.grant(bob, "schedule-private")).rootPath);
    expect(push.rootPath).not.toBe(new PrivatePushResource(access.grant(bob, "push-private")).rootPath);
  });
});
