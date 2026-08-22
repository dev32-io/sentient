import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Capability, ResourceClass } from "./capability.js";
import { capabilityCoversPath } from "./capability.js";

const privateRoot = "/tmp/sentient-calendar-users/kevin";
const householdRoot = "/tmp/sentient-calendar-shared/home";

function capability(resource: ResourceClass, rootPath: string): Capability {
  return Object.freeze({
    ownerUserId: "kevin" as Capability["ownerUserId"],
    resource,
    rootPath,
    role: "adult",
  });
}

describe("capability path confinement", () => {
  it.each([
    ["calendar-private", privateRoot],
    ["memory-private", privateRoot],
  ] as const)("%s covers its private root but not a household root", (resource, root) => {
    const cap = capability(resource, root);
    expect(capabilityCoversPath(cap, join(privateRoot, "events.db"))).toBe(true);
    expect(capabilityCoversPath(cap, join(householdRoot, "events.db"))).toBe(false);
  });

  it.each([
    ["calendar-household", householdRoot],
    ["memory-household", householdRoot],
  ] as const)("%s covers its household root but not a private root", (resource, root) => {
    const cap = capability(resource, root);
    expect(capabilityCoversPath(cap, join(householdRoot, "events.db"))).toBe(true);
    expect(capabilityCoversPath(cap, join(privateRoot, "events.db"))).toBe(false);
  });

  it("blocks traversal from calendar-private into a household root and vice versa", () => {
    const privateCap = capability("calendar-private", privateRoot);
    const householdCap = capability("calendar-household", householdRoot);
    expect(capabilityCoversPath(privateCap, `${privateRoot}/../sentient-calendar-shared/home/events.db`)).toBe(false);
    expect(capabilityCoversPath(householdCap, `${householdRoot}/../../sentient-calendar-users/kevin/events.db`)).toBe(
      false,
    );
  });
});
