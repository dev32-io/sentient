import { useEffect, useState } from "preact/hooks";

export interface ServiceVersions {
  gateway: string;
  hermes: string;
  stt_service: string;
}

export function useServiceVersions(token: string | null): ServiceVersions | null {
  const [versions, setVersions] = useState<ServiceVersions | null>(null);

  useEffect(() => {
    if (!token) return;

    fetch("/api/v1/services/versions", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(setVersions)
      .catch(() => setVersions(null));
  }, [token]);

  return versions;
}
