// Shared tool vocabulary consumed across the native agent loop's tool
// surface (Plan 2, spec §3). Created here because Task 3's McpClient is the
// first tool producer/consumer; Task 4 (ToolBroker) and later the ReAct loop
// import from this module rather than redefining the shapes locally.

/** Dispatch lane a tool runs on. `foreground` blocks the current ReAct turn
 *  and its result feeds straight back into the model; `background` runs
 *  off-turn (e.g. delegateTask) and reports back asynchronously. */
export type ToolCategory = "foreground" | "background";

/** Outcome of a single tool call, normalized across every tool source (MCP,
 *  gateway-native, delegated) into one shape the ReAct loop can feed back
 *  to the model unchanged. */
export interface ToolResult {
  content: string;
  isError: boolean;
}

/** A tool's advertised shape, as presented to the model's tool-list. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: ToolCategory;
}

/** A single in-flight tool call, as dispatched by the loop to a broker. */
export interface ToolInvocation {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  signal: AbortSignal;
  /** The turn this call belongs to. Carried so background dispatch can
   *  key its `delegation.progress` frames to a turn (spec §7). This does
   *  NOT reopen "who appends to the store" — tool_call/tool_result appends
   *  stay in react-loop.ts (see tool-broker.ts's file header); the broker
   *  reads this field for frame correlation only. */
  turnId: string;
}

/** Thrown by a `requestConfirm` implementation when the permission request
 *  could not be ANSWERED at all — timed out, the socket closed, or the turn
 *  was aborted underneath it. `tool-broker.ts` turns it into a deny whose
 *  `message` reaches the model verbatim as the tool result, so the model can
 *  adapt ("permission request timed out") instead of seeing a generic error.
 *  Any OTHER throw out of the hook stays an opaque "confirmation error":
 *  a buggy hook must never leak internals into the model's context. */
export class ConfirmUnavailableError extends Error {}

/** Lifecycle of one background (delegated) task, as surfaced to the client
 *  via the `delegation.progress` frame (spec §5.4/§7). `agent` is the
 *  delegated worker's name (`delegateTask`'s `agent` argument), falling back
 *  to the tool name for a background tool that has no `agent` arg. `note`
 *  carries a short failure reason on `status: "error"` only. */
export interface DelegationProgress {
  taskId: string;
  turnId: string;
  agent: string;
  status: "running" | "done" | "error";
  note?: string;
}

/** Policy Decision Point verdict for a tool invocation (spec §L3 choke
 *  point). `confirm` means the call is allowed only after explicit
 *  human-in-the-loop confirmation. */
export type PdpDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "confirm"; reason: string };
