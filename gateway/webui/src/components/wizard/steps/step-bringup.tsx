import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "wizard", "step-bringup"]);

interface ServiceRow {
  name: string;
  state:
    | "pending"
    | "starting"
    | "health-checking"
    | "ready"
    | "degraded"
    | "failed"
    | "blocked-by-dep"
    | "pending-secrets";
  optional: boolean;
  lastError: string | null;
}

interface Status {
  state: "idle" | "planning" | "applying" | "ready" | "failed";
  services: ServiceRow[];
}

const POLL_MS = 1000;

export interface StepBringupProps {
  onAdvance: () => Promise<void>;
}

export function StepBringup({ onAdvance }: StepBringupProps): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let active = true;

    async function poll() {
      while (active) {
        try {
          const r = await fetch("/api/v1/system/apply-status");
          if (r.ok) {
            const s = (await r.json()) as Status;
            setStatus(s);
            log.debug("step-bringup.poll", { state: s.state });
            if (s.state === "ready") {
              const finish = await fetch("/api/v1/wizard/complete-bringup", {
                method: "POST",
              });
              if (finish.ok) {
                log.info("step-bringup.complete");
                await onAdvance();
                active = false;
                return;
              }
            }
          }
        } catch (err) {
          log.warn("step-bringup.poll-error", { err: String(err) });
        }
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
    }

    void poll();
    return () => {
      active = false;
    };
  }, [onAdvance]);

  async function retry() {
    setRetrying(true);
    try {
      const r = await fetch("/api/v1/wizard/retry-bringup", { method: "POST" });
      if (!r.ok) {
        log.warn("step-bringup.retry-failed");
      }
    } finally {
      setRetrying(false);
    }
  }

  const requiredFailed =
    status?.services.some((s) => !s.optional && s.state === "failed") ?? false;

  return (
    <section class="step-bringup">
      <h2>Starting up services…</h2>
      <p>This will only take a moment. We're bringing the assistant's services online.</p>

      <ul class="step-bringup__services">
        {(status?.services ?? []).map((s) => (
          <li key={s.name} class="step-bringup__service">
            <span class="step-bringup__name">
              {s.name}
              {s.optional && " (optional)"}
            </span>
            <span class="step-bringup__state">{labelForState(s.state)}</span>
            {s.lastError && (
              <span class="step-bringup__error">{s.lastError}</span>
            )}
          </li>
        ))}
      </ul>

      <footer class="step-bringup__footer">
        {requiredFailed && (
          <button
            class="step-bringup__retry"
            type="button"
            disabled={retrying}
            onClick={retry}
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
      </footer>
    </section>
  );
}

function labelForState(s: ServiceRow["state"]): string {
  switch (s) {
    case "pending":
      return "Queued";
    case "starting":
      return "Starting…";
    case "health-checking":
      return "Checking health…";
    case "ready":
      return "Ready ✓";
    case "degraded":
      return "Degraded — will continue without this";
    case "failed":
      return "Failed";
    case "blocked-by-dep":
      return "Waiting on dependency";
    case "pending-secrets":
      return "Skipped — no credentials provided";
  }
}
