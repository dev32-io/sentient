import { catalogTools } from "@sentient/config";
import { describe, expect, it } from "vitest";
import { loadShippedCatalog } from "../testing/shipped-catalog.js";
import { type DelegatableTool, selectDelegatedTools } from "./delegated-tool-tier.js";

// ---------------------------------------------------------------------------
// SECURITY BOUNDARY — what an agent NOBODY IS WATCHING is allowed to hold.
//
// Runs against the SHIPPED `config.yaml#mcp_catalog` on purpose. A one-word
// tier edit is what moves a tool across this line, and the failure it would
// otherwise cause is invisible: a `write`-tier tool advertised on the delegated
// socket has no human to confirm it and no broker prompt that can succeed, so
// it is granted unmediated or it is broken, and neither shows up in a smoke run.
// ---------------------------------------------------------------------------

const catalog = loadShippedCatalog();

function shipped(name: string): DelegatableTool {
  const found = catalogTools(catalog).find((tool) => tool.name === name);
  if (!found) throw new Error(`config.yaml#mcp_catalog no longer curates "${name}"`);
  return { name: found.name, tier: found.tier };
}

describe("selectDelegatedTools admits the read tier and nothing above it", () => {
  it("keeps the gateway's own session-scoped tools, which are read-tier by rule", () => {
    const hosted = ["identify_user", "pause_audio", "resume_audio", "update_user_settings"].map(shipped);
    expect(selectDelegatedTools(hosted).map((tool) => tool.name)).toEqual([
      "identify_user",
      "pause_audio",
      "resume_audio",
      "update_user_settings",
    ]);
  });

  it("SECURITY: withholds every write-tier catalog tool", () => {
    const writes = catalogTools(catalog).filter((tool) => tool.tier === "write");
    expect(writes.length).toBeGreaterThan(0);
    expect(selectDelegatedTools(writes)).toEqual([]);
  });

  it("SECURITY: withholds every confirm-tier catalog tool", () => {
    const confirms = catalogTools(catalog).filter((tool) => tool.tier === "confirm");
    expect(confirms.length).toBeGreaterThan(0);
    expect(selectDelegatedTools(confirms)).toEqual([]);
  });

  // BOTH DIRECTIONS in one pass over the real catalog. The positive half is
  // what stops "withholds everything" from satisfying the two above.
  it("SECURITY: admits exactly the read tier of the whole shipped catalog", () => {
    const all = catalogTools(catalog);
    const admitted = selectDelegatedTools(all).map((tool) => tool.name);
    const readTier = all.filter((tool) => tool.tier === "read").map((tool) => tool.name);
    expect(admitted).toEqual(readTier);
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.length).toBeLessThan(all.length);
  });

  it("preserves order, so the advertised surface is stable across refreshes", () => {
    const tools = [shipped("ha_get_state"), shipped("ha_call_service"), shipped("ha_search")];
    expect(selectDelegatedTools(tools).map((tool) => tool.name)).toEqual(["ha_get_state", "ha_search"]);
  });
});
