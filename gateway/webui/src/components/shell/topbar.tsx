import type { JSX } from "preact";
import { IconButton } from "../common/icon-button.tsx";
import { SentientMark, type SentientMarkMode } from "../common/sentient-mark.tsx";
import { StatusChip } from "../common/status-chip.tsx";
import { UserMenu } from "./user-menu.tsx";
import type { AuthUser } from "../../services/auth-api.ts";

export type TopbarRoute = "chat" | "settings";

export interface TopbarProps {
  householdName: string;
  routeLabel: string;
  deviceCount: number;
  activeRoute: TopbarRoute;
  markMode?: SentientMarkMode;
  onChatClick(): void;
  onSettingsClick(): void;
  onNotificationsClick(): void;
  onMenuClick?(): void;
  user?: AuthUser;
  onLogout?: () => void;
  onOpenAccount?: () => void;
}

export function Topbar({
  householdName,
  routeLabel,
  deviceCount,
  activeRoute,
  markMode = "idle",
  onChatClick,
  onSettingsClick,
  onNotificationsClick,
  onMenuClick,
  user,
  onLogout,
  onOpenAccount,
}: TopbarProps): JSX.Element {
  return (
    <div class="topbar">
      {onMenuClick && (
        <IconButton iconName="menu" title="Past chats" onClick={onMenuClick} />
      )}
      <div class="topbar__brand">
        <SentientMark size={26} mode={markMode} className="topbar__mark" />
        <span class="topbar__brand-name">Sentient</span>
      </div>
      <div class="topbar__crumbs" aria-label="Location">
        <span>{householdName}</span>
        <span class="topbar__crumb-dot" aria-hidden="true" />
        <span>{routeLabel}</span>
      </div>
      <div class="topbar__spacer" />
      <StatusChip label={`${deviceCount} devices online`} indicator="live" />
      <IconButton
        iconName="chat"
        title="Conversation"
        active={activeRoute === "chat"}
        onClick={onChatClick}
      />
      <IconButton
        iconName="bell"
        title="Notifications"
        onClick={onNotificationsClick}
      />
      <IconButton
        iconName="settings"
        title="Household"
        active={activeRoute === "settings"}
        onClick={onSettingsClick}
      />
      {user && onLogout && onOpenAccount && (
        <UserMenu user={user} onLogout={onLogout} onOpenAccount={onOpenAccount} />
      )}
    </div>
  );
}