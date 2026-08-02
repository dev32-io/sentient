// gateway/webui/src/components/settings/panes/tools-pane.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type {
  HermesBuiltinToolView,
  McpCatalogView,
  ProfileApi,
  ProfileV1,
} from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Toggle } from "../primitives/toggle.tsx";
import { Icon } from "../../common/icon.tsx";

const log = createLogger(["sentient", "webui", "settings", "tools-pane"]);

export interface ToolsPaneProps {
  api: ProfileApi;
  token: string | null;
  draft: ProfileV1;
  onDraftTools: (tools: ProfileV1["tools"]) => void;
}

export function ToolsPane({ api, token, draft, onDraftTools }: ToolsPaneProps): JSX.Element {
  const enabled = draft.tools.enabled;
  const toolsets = draft.tools.toolsets ?? [];
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [hermesOpen, setHermesOpen] = useState(true);
  const [catalog, setCatalog] = useState<McpCatalogView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      const r = await api.getMcpCatalog(token);
      if (cancelled) return;
      if (r.ok) {
        setCatalog(r.value);
        setError(null);
      } else {
        log.warn("getMcpCatalog.failed", { code: r.error.code });
        setError(r.error.code);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  const handleToggleServer = (id: string, defaultInclude: readonly string[]) => {
    const isEnabled = id in enabled;
    const next = { ...enabled };
    if (isEnabled) {
      delete next[id];
    } else {
      // Seed with the operator default whitelist so the per-tool checkboxes
      // start in their canonical positions. Empty array would mean "inherit
      // catalog default" today — but materializing the list makes the UI
      // unambiguous and stops a subsequent untoggle-then-retoggle from
      // resurrecting tools the user already turned off.
      next[id] = [...defaultInclude];
    }
    log.debug("tools.toggle-server", { id, nextEnabled: !isEnabled });
    onDraftTools({ ...draft.tools, enabled: next });
  };

  const handleToggleTool = (serverId: string, toolName: string, defaultInclude: readonly string[]) => {
    const current = enabled[serverId];
    if (current === undefined) return;
    // Empty list = "inherit default". Materialize before mutating so we can
    // opt out of the default without flipping the whole server off.
    const baseline = current.length === 0 ? [...defaultInclude] : current;
    const isOn = baseline.includes(toolName);
    const nextList = isOn ? baseline.filter((t) => t !== toolName) : [...baseline, toolName];
    log.debug("tools.toggle-tool", { serverId, toolName, nextOn: !isOn, listLen: nextList.length });
    onDraftTools({ ...draft.tools, enabled: { ...enabled, [serverId]: nextList } });
  };

  const handleToggleHermesToolset = (toolset: string) => {
    const isOn = toolsets.includes(toolset);
    const next = isOn ? toolsets.filter((t) => t !== toolset) : [...toolsets, toolset];
    log.debug("tools.toggle-hermes-toolset", { toolset, nextOn: !isOn });
    onDraftTools({ ...draft.tools, toolsets: next });
  };

  if (!catalog) {
    return (
      <>
        <PaneHead title="Tools" sub="Loading MCP catalog…" />
        {error && <div class="empty-pad">Failed to load catalog ({error}). Reload to retry.</div>}
      </>
    );
  }

  const serverIds = Object.keys(catalog.servers).sort();

  return (
    <>
      <PaneHead
        title="Tools"
        sub="Tools available to the assistant on each cycle. Toggle a server or built-in tool group on/off, or expand to gate individual tools. Changes apply after you save settings."
      />

      <Card title="MCP servers" padding={false}>
        <div class="mcp-list">
          {serverIds.length === 0 && (
            <div class="empty-pad">
              No tools configured. An admin can add tools in <code>gateway/config.yaml#mcp_catalog</code>.
            </div>
          )}
          {serverIds.map((id) => {
            const entry = catalog.servers[id];
            if (!entry) return null;
            return (
              <McpServerSection
                key={id}
                id={id}
                entry={entry}
                isEnabled={id in enabled}
                userInclude={enabled[id]}
                isOpen={!!open[id]}
                onToggleOpen={() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
                onToggleServer={() => handleToggleServer(id, entry.defaultInclude)}
                onToggleTool={(toolName) => handleToggleTool(id, toolName, entry.defaultInclude)}
              />
            );
          })}
        </div>
      </Card>

      <HermesBuiltinsCard
        tools={catalog.hermesBuiltins}
        enabledToolsets={toolsets}
        isOpen={hermesOpen}
        onToggleOpen={() => setHermesOpen((v) => !v)}
        onToggleToolset={handleToggleHermesToolset}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// MCP server section — header row + collapsible per-tool table
// ---------------------------------------------------------------------------

interface McpServerSectionProps {
  id: string;
  entry: McpCatalogView["servers"][string];
  isEnabled: boolean;
  userInclude: readonly string[] | undefined;
  isOpen: boolean;
  onToggleOpen: () => void;
  onToggleServer: () => void;
  onToggleTool: (toolName: string) => void;
}

function McpServerSection(props: McpServerSectionProps): JSX.Element {
  const { id, entry, isEnabled, userInclude, isOpen, onToggleOpen, onToggleServer, onToggleTool } = props;
  // Active count: tools currently enabled (either via the user's explicit
  // list, or — when empty — the inherited operator default). Total: the
  // operator-declared universe.
  const activeNames: readonly string[] =
    userInclude !== undefined && userInclude.length > 0 ? userInclude : entry.defaultInclude;
  const toolsActive = isEnabled ? activeNames.length : 0;
  const toolsTotal = entry.tools.length;

  return (
    <div class="mcp">
      <div
        class="mcp-h mcp-h-btn"
        role="button"
        tabIndex={0}
        onClick={onToggleOpen}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleOpen();
          }
        }}
      >
        <span class={["mcp-chev", isOpen && "open"].filter(Boolean).join(" ")}>
          <Icon name="chevron" size={12} />
        </span>
        <div class="mcp-id">
          <div class="mcp-name">
            <code class="kbd">{id}</code>
          </div>
          {entry.description && <div class="mcp-desc dim">{entry.description}</div>}
        </div>
        <span class="mcp-count dim">{isEnabled ? `${toolsActive}/${toolsTotal} tools` : "off"}</span>
        <span onClick={(e: MouseEvent) => e.stopPropagation()}>
          <Toggle on={isEnabled} onChange={onToggleServer} />
        </span>
      </div>
      {isOpen && isEnabled && entry.tools.length > 0 && (
        <ToolTable
          rows={entry.tools.map((t) => ({
            key: t.name,
            name: t.name,
            description: t.description,
            on: activeNames.includes(t.name),
            onChange: () => onToggleTool(t.name),
          }))}
        />
      )}
      {isOpen && isEnabled && entry.tools.length === 0 && (
        <div class="tool-table">
          <div class="tool-row tool-row-placeholder">
            <div class="tc-tog" />
            <div class="tc-desc tc-placeholder">
              No tools declared for this server. Edit <code>gateway/config.yaml#mcp_catalog</code> and add{" "}
              <code>tools.available</code>.
            </div>
          </div>
        </div>
      )}
      {isOpen && !isEnabled && (
        <div class="tool-table">
          <div class="tool-row tool-row-placeholder">
            <div class="tc-tog" />
            <div class="tc-desc tc-placeholder">Server is off. Toggle on to enable and configure individual tools.</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hermes built-ins card
// ---------------------------------------------------------------------------

interface HermesBuiltinsCardProps {
  tools: readonly HermesBuiltinToolView[];
  enabledToolsets: readonly string[];
  isOpen: boolean;
  onToggleOpen: () => void;
  onToggleToolset: (toolset: string) => void;
}

function HermesBuiltinsCard(props: HermesBuiltinsCardProps): JSX.Element {
  const { tools, enabledToolsets, isOpen, onToggleOpen, onToggleToolset } = props;
  // Count tools by their toolset's current on/off state. A toolset row is
  // "on" iff its toolset name is in `profile.tools.toolsets`.
  const { activeCount, totalCount } = useMemo(() => {
    const total = tools.length;
    const active = tools.filter((t) => enabledToolsets.includes(t.toolset)).length;
    return { activeCount: active, totalCount: total };
  }, [tools, enabledToolsets]);

  // Sort by toolset then name so related tools group visually.
  const sorted = useMemo(() => {
    return [...tools].sort((a, b) => a.toolset.localeCompare(b.toolset) || a.name.localeCompare(b.name));
  }, [tools]);

  return (
    <Card title="Hermes built-in tools" padding={false}>
      <div class="mcp-list">
        <div class="mcp">
          <div
            class="mcp-h mcp-h-btn"
            role="button"
            tabIndex={0}
            onClick={onToggleOpen}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggleOpen();
              }
            }}
          >
            <span class={["mcp-chev", isOpen && "open"].filter(Boolean).join(" ")}>
              <Icon name="chevron" size={12} />
            </span>
            <div class="mcp-id">
              <div class="mcp-name">
                <code class="kbd">hermes</code>
              </div>
              <div class="mcp-desc dim">
                Tools that run inside Hermes itself (memory, todo, web, browser, etc.). Toggles operate on toolset
                groups — flipping any tool in a group flips the whole group.
              </div>
            </div>
            <span class="mcp-count dim">
              {activeCount}/{totalCount} tools
            </span>
          </div>
          {isOpen && (
            <ToolTable
              rows={sorted.map((t) => ({
                key: t.name,
                name: t.name,
                description: t.description,
                badge: t.toolset,
                on: enabledToolsets.includes(t.toolset),
                onChange: () => onToggleToolset(t.toolset),
              }))}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared tool table — header + rows
// ---------------------------------------------------------------------------

interface ToolRow {
  key: string;
  name: string;
  description: string;
  badge?: string;
  on: boolean;
  onChange: () => void;
}

function ToolTable({ rows }: { rows: readonly ToolRow[] }): JSX.Element {
  return (
    <div class="tool-table">
      <div class="tool-row tool-row-head">
        <div class="tc-tog tc-th">On</div>
        <div class="tc-name tc-th">Tool</div>
        <div class="tc-desc tc-th">Description</div>
      </div>
      {rows.map((r) => (
        <div key={r.key} class="tool-row">
          <div class="tc-tog">
            <Toggle on={r.on} onChange={r.onChange} />
          </div>
          <div class="tc-name">
            <code class="kbd">{r.name}</code>
            {r.badge && <span class="tc-badge">{r.badge}</span>}
          </div>
          <div class="tc-desc dim">{r.description || <span class="tc-placeholder">No description.</span>}</div>
        </div>
      ))}
    </div>
  );
}
