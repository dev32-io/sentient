import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Dialog } from "../common/dialog.tsx";
import { ActionButton } from "../common/foundation.tsx";

interface NavigationState {
  dirty: boolean;
  busy: boolean;
}

/** Shell-owned permission to leave, requested before navigation/session effects. */
export function useSettingsDeparture() {
  const latest = useRef<NavigationState>({ dirty: false, busy: false });
  const [state, setState] = useState(latest.current);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((allowed: boolean) => void) | null>(null);
  const stayRef = useRef<HTMLButtonElement | null>(null);

  const onStateChange = useCallback((next: NavigationState) => {
    if (latest.current.dirty === next.dirty && latest.current.busy === next.busy) return;
    latest.current = next;
    setState(next);
  }, []);

  const request = useCallback((): Promise<boolean> => {
    // Never replace a pending choice with another action behind the modal.
    if (resolver.current) return Promise.resolve(false);
    if (!latest.current.dirty && !latest.current.busy) return Promise.resolve(true);
    return new Promise((resolve) => {
      resolver.current = resolve;
      setOpen(true);
    });
  }, []);

  const finish = useCallback((allowed: boolean) => {
    if (allowed && latest.current.busy) return;
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(false);
    resolve?.(allowed);
  }, []);

  // Auth expiry/removal is not a user-approved navigation. No waiting action
  // may run against the disposed authenticated session after this unmounts.
  useEffect(() => () => {
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(false);
  }, []);

  const dialog = open ? (
    <Dialog
      title={state.busy ? "Saving your changes" : state.dirty ? "Discard unsaved changes?" : "Leave settings?"}
      description={state.busy
        ? "Please wait for saving to finish before leaving settings."
        : state.dirty
          ? "Your unapplied changes will be lost. Changes already saved will be kept."
          : "Your changes have been saved. You can leave settings now."}
      onClose={() => finish(false)}
      initialFocusRef={stayRef}
      footer={<>
        <ActionButton variant="quiet" buttonRef={stayRef} onClick={() => finish(false)}>Stay</ActionButton>
        {!state.busy && <ActionButton variant={state.dirty ? "destructive" : "primary"} onClick={() => finish(true)}>
          {state.dirty ? "Discard changes" : "Leave settings"}
        </ActionButton>}
      </>}
    />
  ) : null;

  return { request, onStateChange, dialog };
}
