import type { JSX } from "preact";
import type { AvatarTint } from "../common/avatar.tsx";

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

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") onSelect(userId);
  };

  return (
    <button
      class="avatar-tile"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={displayName}
    >
      <span class={`avatar-tile__circle avatar-tile__circle--tint-${avatarTint}`}>
        {initial}
      </span>
      <span class="avatar-tile__name">{displayName}</span>
    </button>
  );
}