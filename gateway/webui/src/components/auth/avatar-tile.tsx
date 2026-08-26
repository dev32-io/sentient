import type { JSX } from "preact";
import { Avatar, type AvatarTint } from "../common/avatar.tsx";
import { DominantVisualCard } from "../common/composites.tsx";

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
    <DominantVisualCard
      className="avatar-tile"
      label={displayName}
      visual={<Avatar kind="user" initial={initial} name={displayName} tint={avatarTint} size="xl" />}
      onActivate={() => onSelect(userId)}
      ariaLabel={`Continue as ${displayName}`}
    />
  );
}
