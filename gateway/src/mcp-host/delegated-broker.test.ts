import type { OrchestratorConfig } from "@sentient/config";
import type { UserRole } from "@sentient/protocol";
import { describe, expect, it } from "vitest";
import type { AccessManager } from "../access/access-manager.js";
import type { Capability, ResourceClass } from "../access/capability.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { McpClient } from "../tools/mcp-client.js";
import { NEVER_REVOKED } from "../user-auth/credential-floor.js";
import type { StoreResult, UserRecord } from "../user-auth/types.js";
import { createDelegatedBrokerFactory } from "./delegated-broker.js";

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY — a delegation may never hold authority its delegator does
// not (plan 2026-08-07-tool-permissions, task 2b step 6).
//
// This used to be a constant: `DELEGATED_PRINCIPAL_ROLE = "adult"`, which was
// harmless only while EVERY principal was an adult. The moment roles became
// real it would have meant a child's `delegateTask` running with an adult's
// authority — the delegated path silently ceasing to track its delegator.
//
// The bound is proved at the MINT, not at the call: `AccessManager.grant` is
// the one place a principal becomes authority (spec §2.1/L1), and the broker
// holds the resulting capability by value with no ambient principal to reach
// for. So asserting on the principal handed to `grant` asserts on the only
// authority the broker can ever exercise. The spy below records it.
// ---------------------------------------------------------------------------

const USER_ID = "u_a1b2c3d4";
const TOOLS_CONFIG = { max_concurrent_background_tasks: 1 } as OrchestratorConfig["tools"];

function record(role: UserRole): UserRecord {
  return {
    userId: USER_ID,
    displayName: "Delegator",
    pinHash: "$argon2id$fake",
    role,
    avatarTint: "terra",
    createdAt: "2026-08-07T00:00:00.000Z",
    credentialsValidFrom: NEVER_REVOKED,
  };
}

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

interface Harness {
  brokerFor: (userId: string) => Promise<unknown>;
  /** Every principal `AccessManager.grant` was called with, in order. */
  granted: UserPrincipal[];
  setRecord(next: UserRecord | null): void;
}

function harness(initial: UserRecord | null): Harness {
  let stored = initial;
  const granted: UserPrincipal[] = [];
  const accessManager: AccessManager = {
    userHomeDir: (principal) => `/tmp/sentient-delegated-test/${principal.userId}`,
    grant(principal: UserPrincipal, resource: ResourceClass): Capability {
      granted.push(principal);
      return Object.freeze({
        ownerUserId: principal.userId,
        resource,
        rootPath: `/tmp/sentient-delegated-test/${principal.userId}`,
        role: principal.role,
      }) as Capability;
    },
  };
  const brokerFor = createDelegatedBrokerFactory({
    mcp: { listTools: async () => [] } as unknown as McpClient,
    catalog: {},
    toolsConfig: TOOLS_CONFIG,
    accessManager,
    profileStore: { get: async () => ({ ok: false, error: "not-found" }) } as unknown as ProfileStore,
    userStore: { get: async () => ok(stored) as StoreResult<UserRecord | null> },
  });
  return {
    brokerFor,
    granted,
    setRecord(next) {
      stored = next;
    },
  };
}

describe("a delegated broker's authority is its delegator's own role", () => {
  for (const role of ["admin", "adult", "child", "guest"] as const) {
    it(`mints a ${role} delegator's capability with the ${role} role, not a constant`, async () => {
      const h = harness(record(role));
      expect(await h.brokerFor(USER_ID)).not.toBeNull();
      expect(h.granted).toHaveLength(1);
      expect(h.granted[0]?.role).toBe(role);
    });
  }

  // FAIL CLOSED. No delegator means no authority to attenuate, so there is
  // nothing to mint — `proxied-catalog-tool.ts` turns the null into a legible
  // refusal rather than an unmediated call.
  it("mints nothing at all when the delegator's record cannot be resolved", async () => {
    const h = harness(null);
    expect(await h.brokerFor(USER_ID)).toBeNull();
    expect(h.granted).toEqual([]);
  });

  // THE CACHE IS PART OF THE BOUND. A capability holds its role by value, so a
  // broker cached while its user was an adult would keep adult authority after
  // a demotion — the cache would become the escalation the lookup prevents.
  it("rebuilds on a demotion rather than serving the cached higher role", async () => {
    const h = harness(record("adult"));
    await h.brokerFor(USER_ID);
    h.setRecord(record("child"));
    await h.brokerFor(USER_ID);
    expect(h.granted.map((p) => p.role)).toEqual(["adult", "child"]);
  });

  it("rebuilds on a promotion too, so a re-roled user is not stuck low", async () => {
    const h = harness(record("guest"));
    await h.brokerFor(USER_ID);
    h.setRecord(record("admin"));
    await h.brokerFor(USER_ID);
    expect(h.granted.map((p) => p.role)).toEqual(["guest", "admin"]);
  });

  it("reuses the cached broker while the role is unchanged", async () => {
    const h = harness(record("adult"));
    const first = await h.brokerFor(USER_ID);
    const second = await h.brokerFor(USER_ID);
    expect(second).toBe(first);
    expect(h.granted).toHaveLength(1);
  });
});
