// What the settings sidebar OFFERS, per role.
//
// This is a DISPLAY decision, not an authorization one — every pane behind it
// calls a server that resolves the caller's role from the user record on each
// request (`require-admin-auth.ts`), and a member who reached Members anyway
// would get 403s and nothing else. It is pinned all the same because the
// defect it closes was found in an end-to-end run and is invisible from the
// server side: a demoted admin re-logged in and was still shown the Admin
// group, then left clicking a pane that only produces errors.
//
// The whole key list is asserted, not the absence of two keys. An absence
// assertion passes when the gate is over-applied — hiding Account along with
// Members would be just as wrong, and just as silent.

import { describe, expect, it } from "vitest";
import { type SidebarKey, navGroupsFor } from "./nav-config.ts";

function keysOf(isAdmin: boolean): SidebarKey[] {
  return navGroupsFor(isAdmin).flatMap((group) => group.items.map((item) => item.key));
}

const EVERYONE: SidebarKey[] = [
  "memory",
  "personalities",
  "voice",
  "audio",
  "model",
  "tools",
  "systemPrompt",
  "advanced",
  "account",
  "getApp",
  "diagnostics",
];

const ADMIN_ONLY: SidebarKey[] = ["members", "secrets"];

describe("navGroupsFor", () => {
  it("offers an admin every tab, including the admin-only panes", () => {
    expect(keysOf(true)).toEqual([...EVERYONE, ...ADMIN_ONLY]);
  });

  it("offers a member every tab EXCEPT the admin-only panes", () => {
    expect(keysOf(false)).toEqual(EVERYONE);
  });

  it("drops the Admin heading itself for a member, so no empty group renders", () => {
    expect(navGroupsFor(true).map((g) => g.group)).toEqual(["Soul", "User", "Admin"]);
    expect(navGroupsFor(false).map((g) => g.group)).toEqual(["Soul", "User"]);
  });
});
