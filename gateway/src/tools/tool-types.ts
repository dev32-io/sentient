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
}

/** Policy Decision Point verdict for a tool invocation (spec §L3 choke
 *  point). `confirm` means the call is allowed only after explicit
 *  human-in-the-loop confirmation. */
export type PdpDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "confirm"; reason: string };
