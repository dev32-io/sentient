import { getLog } from "../../logging/logger.js";
import type { SessionRouter } from "../../session-router.js";
import type { UserStore } from "../../user-auth/user-store.js";
import type { ToolHandler } from "../mcp-server.js";

const log = getLog(["sentient", "mcp-host", "identify-user"]);

export interface IdentifyUserDeps {
  router: SessionRouter;
  userStore: Pick<UserStore, "list">;
}

export function createIdentifyUserTool(deps: IdentifyUserDeps): ToolHandler {
  return {
    def: {
      name: "identify_user",
      description:
        "Rebinds the current session to a different household member. Call when the user says 'I am X' where X is a known user.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The user id to bind to (e.g., 'alice', 'bob').",
          },
        },
        required: ["name"],
      },
    },
    async run(args, ctx) {
      // TODO(phase-3+): Channel-gate to satellite-only per spec §4.4
      // (`docs/superpowers/specs/2026-04-24-multi-user-auth-and-settings-design.md`).
      // Blocked: ToolContext only carries `sessionChannel: "voice"|"text"` (modality);
      // there is no `originChannel: "satellite"|"web"` signal yet. Each user has one
      // MCP socket today, so satellite vs web callers are indistinguishable at this
      // layer. Adding the gate requires per-origin sockets or a contextFor signal.
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
          content: [
            {
              type: "text",
              text: `identify_user: unknown user "${rawName}". Known users: ${knownNames}`,
            },
          ],
        };
      }
      if (!ctx.userId) {
        log.debug("identify_user.no-socket-user");
        return {
          isError: true,
          content: [{ type: "text", text: "identify_user: no user bound to this connection" }],
        };
      }
      const sessionId = deps.router.findActiveSessionFor(ctx.userId);
      if (!sessionId) {
        log.debug("identify_user.no-session", { name: rawName, socketUser: ctx.userId });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `identify_user: no active session for user "${ctx.userId}"`,
            },
          ],
        };
      }
      try {
        await deps.router.rebind(sessionId, match.userId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("identify_user.rebind-failed", { sessionId, target: match.userId, reason });
        return {
          isError: true,
          content: [{ type: "text", text: `identify_user: rebind failed: ${reason}` }],
        };
      }
      log.debug("identify_user.ok", { sessionId, target: match.userId, socketUser: ctx.userId });
      return {
        content: [{ type: "text", text: `rebound to ${match.displayName}` }],
      };
    },
  };
}
