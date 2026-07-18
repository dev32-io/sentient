import { getLog } from "../../logging/logger.js";
import type { UserStore } from "../../user-auth/user-store.js";
import type { ToolHandler } from "../mcp-server.js";

const log = getLog(["sentient", "mcp-host", "identify-user"]);

export interface IdentifyUserDeps {
  userStore: Pick<UserStore, "list">;
}

/**
 * identify_user — responds to "I am X" by directing X to authenticate.
 *
 * SECURITY INVARIANT: a live session's identity is set by the auth token at
 * connect and is immutable for the session's lifetime. Switching accounts must
 * go through re-authentication (log out → log in as X), which yields a fresh
 * session under X's isolated scope (its own PersonSession, Hermes worker, and
 * conversation). This tool therefore NEVER rebinds the session — a silent
 * in-place identity change would grant the current session another user's live
 * worker + memory without proof of identity. It only validates that X is a
 * known household member and returns guidance to re-authenticate.
 */
export function createIdentifyUserTool(deps: IdentifyUserDeps): ToolHandler {
  return {
    def: {
      name: "identify_user",
      description:
        "Use when a person says 'I am X' and wants to switch to a different household member. For privacy, identity cannot change mid-session — this returns instructions for X to log in on the device. It never grants access to another account's data.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The household member to switch to (e.g., 'alice', 'bob').",
          },
        },
        required: ["name"],
      },
    },
    async run(args, ctx) {
      const rawName = typeof args.name === "string" ? args.name.trim() : "";
      if (!rawName) {
        return {
          isError: true,
          content: [{ type: "text", text: "identify_user: missing name argument" }],
        };
      }
      const usersResult = await deps.userStore.list();
      if (!usersResult.ok) {
        log.warn("identify_user.list-failed", { error: usersResult.error });
        return {
          isError: true,
          content: [{ type: "text", text: "identify_user: cannot enumerate users" }],
        };
      }
      const wanted = rawName.toLowerCase();
      const match = usersResult.value.find((u) => u.userId === rawName || u.displayName.toLowerCase() === wanted);
      if (!match) {
        const knownNames = usersResult.value.map((u) => u.displayName).join(", ");
        return {
          isError: true,
          content: [{ type: "text", text: `identify_user: unknown user "${rawName}". Known users: ${knownNames}` }],
        };
      }
      // Do NOT rebind. Enforce the immutable-session-identity invariant: switching
      // accounts requires re-authentication, which the secure login flow provides.
      log.info("identify_user.switch-requires-reauth", {
        requested: match.userId,
        socketUser: ctx.userId ?? null,
      });
      return {
        content: [
          {
            type: "text",
            text: `To switch to ${match.displayName}, ${match.displayName} needs to sign in on this device. For everyone's privacy I can't switch accounts in the middle of a conversation — please log out and log back in as ${match.displayName}.`,
          },
        ],
      };
    },
  };
}
