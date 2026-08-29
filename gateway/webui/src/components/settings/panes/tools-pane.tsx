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
import { ActionButton, AsyncState, Disclosure, PaneHeader, SelectControl, SettingsCard, ToggleControl, type SelectOption } from "../../common/index.ts";
import { Icon } from "../../common/icon.tsx";
import {
  effectiveToolPermission,
  effectiveWildcardPermission,
  withServerMasterPermission,
  withToolPermission,
} from "./tool-permission-patch.ts";

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
  const [builtinsOpen, setBuiltinsOpen] = useState(true);
  const [catalog, setCatalog] = useState<McpCatalogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

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
  }, [api, token, loadAttempt]);

  const handleToolPermissionChange = (serverId: string, toolName: string, permission: ToolPermission) => {
    log.debug("tools.permission.change", { serverId, toolName, permission });
    onDraftTools({ ...draft.tools, permissions: withToolPermission(permissions, serverId, toolName, permission) });
  };

  // The master control writes a NAMED value for every tool this role can
  // govern, plus the wildcard for whatever that list cannot enumerate — NOT
  // just the wildcard alone. Every account is seeded with a named entry per
  // governable tool at creation, and a named key always outranks the
  // wildcard in resolution order, so a wildcard-only write is a no-op for
  // any tool that already has one — which is most tools, on every existing
  // account. See `withServerMasterPermission`'s doc comment for the full
  // reasoning, including why "on" clears rather than blanket-writes
  // (the anti-ratchet fix) and why "on" necessarily also erases any
  // deliberate per-tool override on this server (no provenance is stored).
  const handleServerMasterToggle = (
    serverId: string,
    toolNames: readonly string[],
    wildcardKey: string,
    turnOn: boolean,
  ) => {
    log.debug("tools.server-master.change", { serverId, toolCount: toolNames.length, wildcardKey, turnOn });
    onDraftTools({
      ...draft.tools,
      permissions: withServerMasterPermission(permissions, serverId, toolNames, wildcardKey, turnOn),
    });
  };

  const handleToggleBuiltinToolset = (toolset: string) => {
    const isOn = toolsets.includes(toolset);
    const next = isOn ? toolsets.filter((t) => t !== toolset) : [...toolsets, toolset];
    log.debug("tools.toggle-builtin-toolset", { toolset, nextOn: !isOn });
    onDraftTools({ ...draft.tools, toolsets: next });
  };

  if (!catalog) {
    return (
      <>
        <PaneHeader title="Tools" subtitle="Loading available capabilities…" />
        {error ? <AsyncState state="error" title="Couldn't load tools" message="Your permissions were not changed." action={<ActionButton onClick={() => setLoadAttempt((value) => value + 1)}>Retry</ActionButton>} /> : <AsyncState state="loading" title="Loading tools" />}
      </>
    );
  }

  const serverIds = Object.keys(catalog.groups).sort();
  const wildcardKey = catalog.wildcardPermissionKey;

  return (
    <>
      <PaneHeader title="Tools" subtitle="Choose whether each capability can run, ask first, be refused, or stay hidden. Changes apply after you save settings." />

      <SettingsCard title="Connected capabilities" padded={false}>
        <div class="mcp-list">
          {serverIds.length === 0 && (
            <div class="empty-pad">
              No connected capabilities are available. An admin can review system Diagnostics for setup help.
            </div>
          )}
          {serverIds.map((id) => {
            const entry = catalog.groups[id];
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
                onMasterToggle={(turnOn) =>
                  handleServerMasterToggle(
                    id,
                    entry.tools.map((t) => t.name),
                    wildcardKey,
                    turnOn,
                  )
                }
                onToolChange={(toolName, permission) => handleToolPermissionChange(id, toolName, permission)}
              />
            );
          })}
        </div>
      </SettingsCard>

      <BuiltinToolsCard
        tools={catalog.hermesBuiltins}
        enabledToolsets={toolsets}
        isOpen={builtinsOpen}
        onToggleOpen={() => setBuiltinsOpen((v) => !v)}
        onToggleToolset={handleToggleBuiltinToolset}
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
  entry: McpCatalogView["groups"][string];
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
      <Disclosure
        className="mcp-disclosure"
        mode="button"
        title={<span class="mcp-name"><code class="kbd">{id}</code></span>}
        description={entry.description ? <span class="mcp-desc dim">{entry.description}</span> : undefined}
        summaryTrailing={<span class="mcp-count dim">{toolsActive}/{toolsTotal} tools</span>}
        open={isOpen}
        onOpenChange={onToggleOpen}
      >
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
      </Disclosure>
      <ToggleControl label={`Enable ${id} capabilities`} checked={masterOn} onChange={onMasterToggle} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Built-in capabilities use toolset on/off controls rather than per-tool permissions.
// ---------------------------------------------------------------------------

interface BuiltinToolsCardProps {
  tools: readonly HermesBuiltinToolView[];
  enabledToolsets: readonly string[];
  isOpen: boolean;
  onToggleOpen: () => void;
  onToggleToolset: (toolset: string) => void;
}

function BuiltinToolsCard(props: BuiltinToolsCardProps): JSX.Element {
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
    <SettingsCard title="Assistant capabilities" subtitle="Built-in capabilities grouped by purpose." padded={false}>
      <div class="mcp-list">
        <div class="mcp mcp--without-master">
          <Disclosure
            className="mcp-disclosure"
            mode="button"
            title="Built in"
            description={<span class="mcp-desc dim">Capabilities provided by the assistant, including memory, lists, web access, and browsing. A switch controls its entire capability group.</span>}
            summaryTrailing={<span class="mcp-count dim">{activeCount}/{totalCount} tools</span>}
            open={isOpen}
            onOpenChange={onToggleOpen}
          >
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
          </Disclosure>
        </div>
      </div>
    </SettingsCard>
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
      <div class="tool-row tool-row-perm tool-row-head">
        <div class="tc-tog tc-th">Permission</div>
        <div class="tc-name tc-th">Tool</div>
        <div class="tc-desc tc-th">Description</div>
      </div>
      {rows.map((r) => (
        <div key={r.key} class={["tool-row", "tool-row-perm", permissionRowModifier(r.permission)].join(" ")}>
          <div class="tc-tog">
            <SelectControl
              label={`${r.name} permission`}
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
// Built-in toolsets use boolean controls rather than four-state permissions.
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
            <ToggleControl label={`Enable ${r.name}`} checked={r.on} onChange={r.onChange} />
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
