import { createLogger } from "@sentient/web-sdk";
import type { WizardStepId } from "@sentient/wizard";
import { useCallback, useEffect, useState } from "preact/hooks";

const log = createLogger(["sentient", "webui", "install-state"]);

export interface InstallState {
  bootstrap_complete: boolean;
  wizard_cursor: WizardStepId;
  unlock_verified: boolean;
  installed_version: string;
  current_version: string;
}

export interface UseInstallStateReturn {
  state: InstallState | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useInstallState(): UseInstallStateReturn {
  const [state, setState] = useState<InstallState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/install-state");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as InstallState;
      setState(body);
    } catch (err) {
      log.warn("install-state.fetch-failed", { err: String(err) });
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { state, loading, refresh };
}
