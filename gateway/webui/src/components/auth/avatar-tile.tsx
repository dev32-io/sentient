import type { JSX } from "preact";
import type { AvatarTint } from "../common/avatar.tsx";
import { ActionButton } from "../common/foundation.tsx";

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

  const handleClick = (): void => onSelect(userId);

  return (
    <ActionButton
      className="avatar-tile"
      variant="quiet"
      onClick={handleClick}
      ariaLabel={`Continue as ${displayName}`}
      title={`Continue as ${displayName}`}
    >
      <span class={`avatar-tile__circle avatar-tile__circle--tint-${avatarTint}`}>
        {initial}
      </span>
      <span class="avatar-tile__name">{displayName}</span>
    </ActionButton>
  );
}