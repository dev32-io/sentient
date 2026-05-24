import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { AuthUser } from "../../services/auth-api.ts";

const log = createLogger(["sentient", "webui", "shell", "user-menu"]);

export interface UserMenuProps {
  user: AuthUser;
  onLogout: () => void;
  onOpenAccount: () => void;
}

export function UserMenu({ user, onLogout, onOpenAccount }: UserMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        log.debug("escape-pressed, closing popover");
        close();
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        log.debug("click-outside, closing popover");
        close();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, close]);

  function handleLogout() {
    log.debug("logout-clicked");
    close();
    onLogout();
  }

  function handleOpenAccount() {
    log.debug("open-account-clicked");
    close();
    onOpenAccount();
  }

  const initial = user.displayName.charAt(0).toUpperCase();

  return (
    <div class="user-menu" ref={containerRef}>
      <button
        type="button"
        class="user-menu__trigger"
        aria-label={user.displayName}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span class={`user-menu__avatar user-menu__avatar--tint-${user.avatarTint}`}>
          {initial}
        </span>
        <span class="user-menu__name">{user.displayName}</span>
      </button>
      {open && (
        <div class="user-menu__popover" role="menu">
          <button type="button" class="user-menu__item" role="menuitem" onClick={handleOpenAccount}>
            My Account
          </button>
          <button type="button" class="user-menu__item" role="menuitem" onClick={handleLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}