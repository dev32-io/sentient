import { createLogger } from "@sentient/web-sdk";
import type { WizardStepId } from "@sentient/wizard";
import { useCallback, useEffect, useState } from "preact/hooks";

const log = createLogger(["sentient", "webui", "install-state"]);
const INSTALL_COMPLETE_CACHE_KEY = "sentient:install-complete";

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
  error: boolean;
  /** Prior successful complete state; permits cached shell only on network failure. */
  offlineComplete: boolean;
  refresh: () => Promise<void>;
}

export function useInstallState(): UseInstallStateReturn {
  const [state, setState] = useState<InstallState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [offlineComplete, setOfflineComplete] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    let res: Response;
    try {
      res = await fetch("/api/v1/install-state");
    } catch (err) {
      const cached = (() => {
        try {
          return localStorage.getItem(INSTALL_COMPLETE_CACHE_KEY) === "true";
        } catch {
          return false;
        }
      })();
      log.warn("install-state.fetch-failed", { errorType: err instanceof Error ? err.name : "unknown" });
      setOfflineComplete(cached);
      setError(!cached);
      setState(null);
      setLoading(false);
      return;
    }
    try {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as InstallState;
      if (typeof body.bootstrap_complete !== "boolean") throw new Error("invalid install state");
      setState(body);
      setOfflineComplete(false);
      try {
        if (body.bootstrap_complete) localStorage.setItem(INSTALL_COMPLETE_CACHE_KEY, "true");
        else localStorage.removeItem(INSTALL_COMPLETE_CACHE_KEY);
      } catch {
        /* storage disabled; online gate still works */
      }
    } catch (err) {
      log.warn("install-state.response-invalid", { errorType: err instanceof Error ? err.name : "unknown" });
      setError(true);
      setState(null);
      setOfflineComplete(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { state, loading, error, offlineComplete, refresh };
}
