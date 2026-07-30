// Late-bound holder for the delegated worker's external tool.
//
// WHY LATE-BOUND, and why that is not a shortcut. The delegated worker's
// configuration (`hermes-external-tool.ts`) needs the tool surface the gateway's
// MCP host advertises, and that host is constructed AFTER the composition root
// that builds `createSessionRuntime` — it depends on the user store, the user
// lifecycle and the session-controls registry that root produces. So the
// dependency genuinely runs the other way for one hop.
//
// This is safe because of WHEN each side runs: the slot is filled once during
// boot, immediately after the MCP host exists, while `get()` is called at
// SESSION-CREATION time — a WS connect, long after boot. Same shape and same
// reasoning as `ToolBroker.setBackgroundCompletionSink`.
//
// An unfilled slot is a degraded path, not a crash: `delegateTask` treats a
// null tool as "nothing to provide" and dispatches anyway. It is logged once at
// read time so the gap is never silent.

import { getLog } from "../logging/logger.js";
import type { ExternalTool } from "./external-tool.js";

const log = getLog(["sentient", "external-tools", "slot"]);

export interface ExternalToolSlot {
  /** Called exactly once, at boot, by the composition root that owns the MCP
   *  host. A second call replaces the tool and is logged. */
  set(tool: ExternalTool): void;
  /** Null until `set` runs — see the file header for why that is tolerable. */
  get(): ExternalTool | null;
}

export function createExternalToolSlot(): ExternalToolSlot {
  let tool: ExternalTool | null = null;
  let warnedEmpty = false;

  return {
    set(next: ExternalTool) {
      log.info("external-tool-slot.set", { tool: next.name, replaced: tool !== null });
      tool = next;
    },
    get() {
      if (tool || warnedEmpty) return tool;
      warnedEmpty = true;
      log.warn("external-tool-slot.empty", {
        reason: "no external tool was bound at boot; delegations run without verifying the delegated worker's config",
      });
      return null;
    },
  };
}
