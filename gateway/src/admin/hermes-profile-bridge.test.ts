import { describe, expect, it } from "vitest";
import { getUserProfileDir } from "../user-auth/paths.js";
import { checkHermesProfileBridge } from "./hermes-profile-bridge.js";

const USER = "u_deadbeef";

describe("checkHermesProfileBridge", () => {
  it("INVARIANT: with HERMES_HOME unset the rendered profile is not the profile hermes reads", () => {
    // The shipped native reality: hermes-runner passes cwd but no env, so the
    // child inherits this env. Unset => hermes resolves its own default store,
    // never the gateway's render. D11.
    const bridge = checkHermesProfileBridge(USER, {});
    expect(bridge.isLive).toBe(false);
    if (bridge.isLive) return;
    expect(bridge.reason).toBe("hermes-home-unset");
    expect(bridge.renderedRoot).toBe(getUserProfileDir(USER));
  });

  it("reports not-live when HERMES_HOME points somewhere other than this user's rendered root", () => {
    const bridge = checkHermesProfileBridge(USER, { HERMES_HOME: "/some/other/home" });
    expect(bridge.isLive).toBe(false);
    if (bridge.isLive) return;
    expect(bridge.reason).toBe("hermes-home-elsewhere");
  });

  it("reports live only when HERMES_HOME is exactly this user's rendered profile root", () => {
    const bridge = checkHermesProfileBridge(USER, { HERMES_HOME: getUserProfileDir(USER) });
    expect(bridge.isLive).toBe(true);
  });
});
