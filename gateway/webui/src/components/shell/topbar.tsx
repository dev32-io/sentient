import { SurfaceAction } from "../common/foundation.tsx";
import type { JSX } from "preact";
import { IconButton } from "../common/icon-button.tsx";
import { SentientMark, type SentientMarkMode } from "../common/sentient-mark.tsx";
import { UserMenu } from "./user-menu.tsx";
import type { AuthUser } from "../../services/auth-api.ts";

export type TopbarRoute = "chat" | "calendar" | "settings";

export interface TopbarProps {
  householdName: string;
  routeLabel: string;
  activeRoute: TopbarRoute;
  markMode?: SentientMarkMode;
  onChatClick(): void;
  onSettingsClick(): void;
  onCalendarClick(): void;
  onMenuClick?(): void;
  user?: AuthUser;
  onLogout?: () => void;
  onOpenAccount?: () => void;
}

export function Topbar({
  householdName,
  routeLabel,
  activeRoute,
  markMode = "idle",
  onChatClick,
  onSettingsClick,
  onCalendarClick,
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
      <SurfaceAction type="button" class="topbar__brand" aria-label="Sentient — go to chat" onClick={onChatClick}>
        <SentientMark size={26} mode={markMode} className="topbar__mark" />
        <span class="topbar__brand-name">Sentient</span>
      </SurfaceAction>
      <div class="topbar__crumbs" aria-label="Location">
        <span>{householdName}</span>
        <span class="topbar__crumb-dot" aria-hidden="true" />
        <span>{routeLabel}</span>
      </div>
      <div class="topbar__spacer" />
      <nav class="topbar__nav" aria-label="Primary">
        <IconButton
          iconName="chat"
          title="Conversation"
          active={activeRoute === "chat"}
          onClick={onChatClick}
        />
        <IconButton
          iconName="calendar"
          title="Calendar"
          active={activeRoute === "calendar"}
          onClick={onCalendarClick}
        />
        <IconButton
          iconName="settings"
          title="Household"
          active={activeRoute === "settings"}
          onClick={onSettingsClick}
        />
      </nav>
      <IconButton
        iconName="bell"
        title="Notifications — coming soon"
        disabled
        onClick={() => undefined}
      />
      {user && onLogout && onOpenAccount && (
        <UserMenu user={user} onLogout={onLogout} onOpenAccount={onOpenAccount} />
      )}
    </div>
  );
}