import { useEffect, useState } from "preact/hooks";

interface ServiceStatus {
  state: string;
  optional: boolean;
}

interface SystemStatus {
  state: string;
  services: ServiceStatus[];
}

export function requiredServicesOnline(status: SystemStatus): boolean {
  return (
    status.state === "ready" &&
    status.services.filter((service) => !service.optional).every((service) => service.state === "ready")
  );
}

export function useSystemReadiness(enabled: boolean): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(null);
      return;
    }

    let active = true;
    const refresh = () => {
      void fetch("/api/v1/system/apply-status")
        .then((response) => (response.ok ? response.json() : null))
        .then((status: SystemStatus | null) => {
          if (active) setReady(status ? requiredServicesOnline(status) : false);
        })
        .catch(() => {
          if (active) setReady(false);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return ready;
}
