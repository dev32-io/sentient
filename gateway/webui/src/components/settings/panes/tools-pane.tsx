// gateway/webui/src/components/settings/panes/tools-pane.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ToolPermission } from "@sentient/config";
import type {
  HermesBuiltinToolView,
  McpCatalogView,
  ProfileApi,
  ProfileV1,
} from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Toggle } from "../primitives/toggle.tsx";
import { Select, type SelectOption } from "../primitives/select.tsx";
import { Icon } from "../../common/icon.tsx";
import { effectiveToolPermission, effectiveWildcardPermission, withToolPermission } from "./tool-permission-patch.ts";

const log = createLogger(["sentient", "webui", "settings", "tools-pane"]);

// `Record<ToolPermission, ...>` rather than a bare array: adding a fifth
// permission value (`auto`, once the classifier lands) makes this object
// literal fail to typecheck until every site that reads it — starting here —
// is updated. That is the whole reason the owner picked a dropdown over a
// segmented toggle for this control.
const PERMISSION_OPTION_BY_VALUE: Record<ToolPermission, SelectOption> = {
  allow: { value: "allow", label: "Allow", tag: "auto" },
  ask: { value: "ask", label: "Ask", tag: "prompts" },
  deny: { value: "deny", label: "Deny", tag: "refused" },
  off: { value: "off", label: "Off", tag: "hidden" },
};
const PERMISSION_OPTIONS: SelectOption[] = Object.values(PERMISSION_OPTION_BY_VALUE);

/** Row-dimming modifier for the shared `.tool-row` style. EXHAUSTIVE, no
 *  `default:` arm — a fifth permission value must break this at compile
 *  time rather than silently falling through to "on". */
function permissionRowModifier(permission: ToolPermission): "on" | "off" {
  switch (permission) {
    case "allow":
    case "ask":
    case "deny":
      return "on";
    case "off":
      return "off";
  }
}

export interface ToolsPaneProps {
  api: ProfileApi;
  token: string | null;
  draft: ProfileV1;
  onDraftTools: (tools: ProfileV1["tools"]) => void;
}

export function ToolsPane({ api, token, draft, onDraftTools }: ToolsPaneProps): JSX.Element {
  const permissions = draft.tools.permissions;
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

  const handleToolPermissionChange = (serverId: string, toolName: string, permission: ToolPermission) => {
    log.debug("tools.permission.change", { serverId, toolName, permission });
    onDraftTools({ ...draft.tools, permissions: withToolPermission(permissions, serverId, toolName, permission) });
  };

  // The master control writes the SAME shape a per-tool Select does — it
  // just targets the server's wildcard key instead of one tool's name.
  // "On" always writes an explicit `allow` rather than trying to restore
  // "unset" (which would mean deleting the wildcard key): every state this
  // pane can put a person into must be one it wrote down, not one it erased
  // its way back to.
  const handleServerMasterToggle = (serverId: string, wildcardKey: string, turnOn: boolean) => {
    const next: ToolPermission = turnOn ? "allow" : "off";
    log.debug("tools.server-master.change", { serverId, wildcardKey, next });
    onDraftTools({ ...draft.tools, permissions: withToolPermission(permissions, serverId, wildcardKey, next) });
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
  const wildcardKey = catalog.wildcardPermissionKey;

  return (
    <>
      <PaneHead
        title="Tools"
        sub="Pick Allow / Ask / Deny / Off per tool, or use a server's master switch to set them all at once. Changes apply after you save settings."
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
                wildcardKey={wildcardKey}
                permissions={permissions}
                isOpen={!!open[id]}
                onToggleOpen={() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
                onMasterToggle={(turnOn) => handleServerMasterToggle(id, wildcardKey, turnOn)}
                onToolChange={(toolName, permission) => handleToolPermissionChange(id, toolName, permission)}
              />
            );
          })}
        </div>
      </Card>

      {catalog.nativeTools.length > 0 && (
        <Card
          title="Gateway tools"
          sub="Built into the gateway itself, not an MCP server — governed by role until a later release lets a person override it."
          padding={false}
        >
          <PermissionToolTable
            rows={catalog.nativeTools.map((t) => ({
              key: t.name,
              name: t.name,
              description: t.description,
              permission: t.permission,
              settable: t.settable,
              onChange: () => {
                // Unreachable: `settable` is false for every row rendered
                // here today, and the Select underneath is disabled — kept
                // as a real no-op rather than omitted so a future settable
                // native tool gets a working handler by just flipping
                // `settable` server-side, no client change required.
              },
            }))}
          />
        </Card>
      )}

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
// MCP server section — header row (name + count + master control) + a
// collapsible per-tool permission table.
// ---------------------------------------------------------------------------

interface McpServerSectionProps {
  id: string;
  entry: McpCatalogView["servers"][string];
  wildcardKey: string;
  permissions: ProfileV1["tools"]["permissions"];
  isOpen: boolean;
  onToggleOpen: () => void;
  onMasterToggle: (turnOn: boolean) => void;
  onToolChange: (toolName: string, permission: ToolPermission) => void;
}

function McpServerSection(props: McpServerSectionProps): JSX.Element {
  const { id, entry, wildcardKey, permissions, isOpen, onToggleOpen, onMasterToggle, onToolChange } = props;

  const effectivePermissions = useMemo(
    () => entry.tools.map((t) => effectiveToolPermission(permissions, id, t)),
    [entry.tools, permissions, id],
  );
  const toolsActive = effectivePermissions.filter((p) => p !== "off").length;
  const toolsTotal = entry.tools.length;

  const wildcard = effectiveWildcardPermission(permissions, id, wildcardKey, entry.wildcardPermission);
  const masterOn = wildcard !== "off";

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
        <span class="mcp-count dim">
          {toolsActive}/{toolsTotal} tools
        </span>
        <span onClick={(e: MouseEvent) => e.stopPropagation()}>
          <Toggle on={masterOn} onChange={() => onMasterToggle(!masterOn)} />
        </span>
      </div>
      {isOpen && (
        <PermissionToolTable
          rows={entry.tools.map((t) => ({
            key: t.name,
            name: t.name,
            description: t.description,
            permission: effectiveToolPermission(permissions, id, t),
            settable: t.settable,
            onChange: (permission: ToolPermission) => onToolChange(t.name, permission),
          }))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hermes built-ins card (unchanged: toolset on/off, not a per-tool
// permission — Task 6 only replaces the MCP + gateway-native controls).
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
            <ToggleToolTable
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
// Permission tool table — one row per tool, a 4-state Select in place of the
// old boolean Toggle. Shared by MCP server sections and gateway-native tools.
// ---------------------------------------------------------------------------

interface PermissionToolRow {
  key: string;
  name: string;
  description: string;
  permission: ToolPermission;
  /** `false` renders the Select genuinely non-interactive (native `disabled`
   *  on the underlying button — no click reaches `onChange`), for a tool a
   *  stored table cannot address (`delegateTask`). */
  settable: boolean;
  onChange: (permission: ToolPermission) => void;
}

function PermissionToolTable({ rows }: { rows: readonly PermissionToolRow[] }): JSX.Element {
  return (
    <div class="tool-table">
      <div class="tool-row tool-row-head">
        <div class="tc-tog tc-th">Permission</div>
        <div class="tc-name tc-th">Tool</div>
        <div class="tc-desc tc-th">Description</div>
      </div>
      {rows.map((r) => (
        <div key={r.key} class={["tool-row", permissionRowModifier(r.permission)].join(" ")}>
          <div class="tc-tog">
            <Select
              value={r.permission}
              options={PERMISSION_OPTIONS}
              onChange={(v) => r.onChange(v as ToolPermission)}
              disabled={!r.settable}
            />
          </div>
          <div class="tc-name">
            <code class="kbd">{r.name}</code>
          </div>
          <div class="tc-desc dim">{r.description || <span class="tc-placeholder">No description.</span>}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle tool table — the original boolean on/off table, kept for the Hermes
// built-ins card (toolset on/off is not a 4-state permission).
// ---------------------------------------------------------------------------

interface ToggleToolRow {
  key: string;
  name: string;
  description: string;
  badge?: string;
  on: boolean;
  onChange: () => void;
}

function ToggleToolTable({ rows }: { rows: readonly ToggleToolRow[] }): JSX.Element {
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
