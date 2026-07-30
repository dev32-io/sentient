import { describe, expect, it } from "vitest";
import { resolveMcpSocketPath } from "./socket-path.js";

describe("resolveMcpSocketPath", () => {
  // FILESYSTEM-CONTRACT INVARIANT (defect D8). The per-user MCP socket used to
  // default to /run/sentient/mcp-<userId>.sock, a leftover from when Hermes ran
  // in a container with a bind-mount there. `/run` does not exist on macOS and
  // its parent is SIP-read-only, so the listener could never open: delegateTask
  // ran but the delegated agent got ZERO gateway tools. The socket must live
  // under the user-owned mutable state root.
  it("INVARIANT: the per-user MCP socket resolves under the state root, not /run", () => {
    const p = resolveMcpSocketPath("u_deadbeef");
    expect(p.startsWith("/run")).toBe(false);
    expect(p).toContain(".sentient");
    // unix sockets have a ~104-byte sun_path limit on macOS; a long state root
    // plus a userId must not silently exceed it.
    expect(p.length).toBeLessThan(100);
  });

  it("derives the per-user socket from the configured base path's directory", () => {
    expect(resolveMcpSocketPath("u_abc", "/tmp/sentient-run/mcp.sock")).toBe("/tmp/sentient-run/mcp-u_abc.sock");
  });

  it("expands a leading ~ in the configured base path", () => {
    const p = resolveMcpSocketPath("u_abc", "~/.sentient/run/mcp.sock");
    expect(p.startsWith("~")).toBe(false);
    expect(p.endsWith("/.sentient/run/mcp-u_abc.sock")).toBe(true);
  });

  // WRITABLE-PATH INVARIANT. `${HOME}` in operator YAML resolves to "" when the
  // env var is unset (shared/config loader contract), which turned the base
  // path into "/.sentient/run/mcp.sock" — root-relative and unwritable. The
  // same class of bug crash-looped the gateway on EROFS in the logging path.
  it("INVARIANT: falls back to the state root when the configured base is root-relative", () => {
    const p = resolveMcpSocketPath("u_abc", "/.sentient/run/mcp.sock");
    expect(p).toBe(resolveMcpSocketPath("u_abc"));
  });

  it("INVARIANT: falls back to the state root when the configured base is relative", () => {
    const p = resolveMcpSocketPath("u_abc", "run/mcp.sock");
    expect(p).toBe(resolveMcpSocketPath("u_abc"));
  });
});
