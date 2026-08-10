import { getLog } from "../../logging/logger.js";
import type { UserStore } from "../../user-auth/user-store.js";
import type { ToolHandler } from "../mcp-server.js";

const log = getLog(["sentient", "mcp-host", "identify-user"]);

/** The one channel on which "I am X" is a thing a person can have SAID. */
const VOICE_CHANNEL = "voice";

/** What the caller is told outside a voice session. Model-facing copy: it says
 *  what to do instead, because the useful answer is available to the model
 *  directly and this tool adds nothing to it. */
const OUTSIDE_VOICE =
  "identify_user applies to a voice session only. In a text session, tell the person directly that they need to log out and log back in as the account they want.";

export interface IdentifyUserDeps {
  userStore: Pick<UserStore, "list">;
}

/**
 * identify_user — responds to "I am X" by directing X to authenticate.
 *
 * SECURITY INVARIANT: a live session's identity is set by the auth token at
 * connect and is immutable for the session's lifetime. Switching accounts must
 * go through re-authentication (log out → log in as X), which yields a fresh
 * session under X's isolated scope (its own per-user session state, Hermes
 * worker, and conversation). This tool therefore NEVER rebinds the session — a silent
 * in-place identity change would grant the current session another user's live
 * worker + memory without proof of identity. It only validates that X is a
 * known household member and returns guidance to re-authenticate.
 *
 * THE CHANNEL GUARD, and why it lives here rather than in a permission table.
 * The retired `mcp-policy.yaml` carried one rule that survives the move to
 * impact tiers + per-person permissions: `no_identify_user_outside_voice`. It
 * is conditioned on `session.channel`, which is per-SESSION — not per-user and
 * not per-role — so no permission table can express it, and the two gates in
 * `tools/tool-broker.ts` deliberately do not try. It is also not really an
 * authorization rule: it says WHEN this tool is meaningful, which is a fact
 * about the tool. So the tool owns it, reading the channel off the `ToolContext`
 * it is already handed. Anyone who re-tiers or re-permissions this tool later
 * cannot accidentally drop the constraint, because it is not in either table.
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
      if (ctx.sessionChannel !== VOICE_CHANNEL) {
        log.info("identify_user.outside-voice", {
          sessionChannel: ctx.sessionChannel,
          socketUser: ctx.userId ?? null,
          reason: "an identity claim is a spoken utterance; in text the model can answer without this tool",
        });
        return { isError: true, content: [{ type: "text", text: OUTSIDE_VOICE }] };
      }
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
