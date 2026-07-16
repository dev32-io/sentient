import { useEffect, useState } from "preact/hooks";

/** Namespaced, extensible feature-flag block. Add future operator-toggleable
 *  flags here rather than as top-level fields. Older gateways predating this
 *  field omit `features` entirely — parseServiceVersions defaults every flag
 *  to false so the corresponding UI stays hidden. */
export interface ServiceVersionsFeatures {
  fish_browse_enabled: boolean;
}

export interface ServiceVersions {
  gateway: string;
  hermes: string;
  stt_service: string;
  tts_service: string;
  features: ServiceVersionsFeatures;
}

/** Raw JSON body may come from an older gateway build without `features`. */
type RawServiceVersions = Omit<ServiceVersions, "features"> & { features?: Partial<ServiceVersionsFeatures> };

function parseServiceVersions(raw: RawServiceVersions): ServiceVersions {
  return {
    ...raw,
    features: {
      fish_browse_enabled: raw.features?.fish_browse_enabled ?? false,
    },
  };
}

export function useServiceVersions(token: string | null): ServiceVersions | null {
  const [versions, setVersions] = useState<ServiceVersions | null>(null);

  useEffect(() => {
    if (!token) return;

    fetch("/api/v1/services/versions", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((raw: RawServiceVersions | null) => setVersions(raw ? parseServiceVersions(raw) : null))
      .catch(() => setVersions(null));
  }, [token]);

  return versions;
}
