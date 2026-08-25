const AUTH_EXPIRED_KEY = "sentient:auth-expired";

export function markAuthExpired(storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(AUTH_EXPIRED_KEY, "1");
  } catch {
    /* storage may be disabled */
  }
}

export function takeAuthExpired(storage: Pick<Storage, "getItem" | "removeItem"> | undefined): boolean {
  try {
    const expired = storage?.getItem(AUTH_EXPIRED_KEY) === "1";
    if (expired) storage?.removeItem(AUTH_EXPIRED_KEY);
    return expired;
  } catch {
    return false;
  }
}
