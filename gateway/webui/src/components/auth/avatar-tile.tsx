import { SurfaceAction } from "../common/foundation.tsx";
import type { JSX } from "preact";
import { Avatar, type AvatarTint } from "../common/avatar.tsx";

export interface AvatarTileProps {
  userId: string;
  displayName: string;
  avatarTint: AvatarTint;
  onSelect: (userId: string) => void;
}

export function AvatarTile({
  userId,
  displayName,
  avatarTint,
  onSelect,
}: AvatarTileProps): JSX.Element {
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <SurfaceAction type="button" class="homecoming__person" data-user-id={userId} onClick={() => onSelect(userId)} aria-label={`Continue as ${displayName}`}>
      <Avatar kind="user" initial={initial} name={displayName} tint={avatarTint} size="lg" />
      <span class="homecoming__person-name">{displayName}</span>
      <span class="homecoming__chevron" aria-hidden="true">›</span>
    </SurfaceAction>
  );
}
