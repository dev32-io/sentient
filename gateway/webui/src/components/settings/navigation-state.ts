import { createContext } from "preact";
import { useCallback, useContext, useLayoutEffect, useRef, useState } from "preact/hooks";

export interface SettingsNavigationState {
  dirty: boolean;
  busy: boolean;
}

/** Counts survive internal pane unmounts until the operation's own finally settles. */
export const SettingsNavigationContext = createContext({
  changeBusy: (_delta: number): void => {},
  changeDirty: (_delta: number): void => {},
});

export function useSettingsBusyState(): [boolean, (busy: boolean) => void] {
  const { changeBusy } = useContext(SettingsNavigationContext);
  const current = useRef(0);
  const [busy, setBusy] = useState(false);
  const update = useCallback(
    (next: boolean) => {
      current.current += next ? 1 : -1;
      changeBusy(next ? 1 : -1);
      setBusy(current.current > 0);
    },
    [changeBusy],
  );
  return [busy, update];
}

/** Only a boolean leaves the editor; no draft values enter navigation state. */
export function useSettingsDraft(dirty: boolean): void {
  const { changeDirty } = useContext(SettingsNavigationContext);
  useLayoutEffect(() => {
    if (!dirty) return;
    changeDirty(1);
    return () => changeDirty(-1);
  }, [dirty, changeDirty]);
}

/** Non-sensitive name draft, scoped to one server identity and its saved name. */
export function useDisplayNameDraft(userId: string | null, savedName: string): [string, (name: string) => void] {
  const [draft, setDraft] = useState({ userId, savedName, value: savedName });
  const matchesIdentity = draft.userId === userId && draft.savedName === savedName;
  useLayoutEffect(() => {
    setDraft({ userId, savedName, value: savedName });
  }, [userId, savedName]);
  const setName = useCallback(
    (value: string) => {
      setDraft({ userId, savedName, value });
    },
    [userId, savedName],
  );
  return [matchesIdentity ? draft.value : savedName, setName];
}
