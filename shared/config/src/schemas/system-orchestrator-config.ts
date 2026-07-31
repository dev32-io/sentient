import { z } from "zod";

// Policy for the SYSTEM orchestrator — the supervisor of docker + native
// addons. Deliberately NOT the `orchestrator:` block, which is the native LLM
// agent loop; the two are different subsystems that share a word.
//
// Sibling `managed_services:` cannot hold these knobs: its schema is a strict
// record of service-name -> service-config, so any non-service key there fails
// the registry build.
export const systemOrchestratorConfigSchema = z.object({
  // How often the orchestrator re-probes addon health after boot and re-applies
  // anything that has gone unhealthy. Range 5000-300000 (5 s - 5 min). Without
  // this a crashed addon never recovers: apply() otherwise runs only at
  // boot/admin/wizard, so nothing re-probes once the gateway is up.
  health_watch_interval_ms: z.number().int().min(5000).max(300000).default(15000),
  // Consecutive failed re-apply attempts before the watchdog gives up on one
  // service and logs an ERROR naming it. Range 1-20. Prevents a service that
  // cannot start (bad config, port taken) from being recreated forever. The
  // watchdog keeps PROBING after giving up, so an out-of-band fix re-arms it.
  health_watch_max_attempts: z.number().int().min(1).max(20).default(5),
  // Multiplier applied to the interval after each failed attempt, so retries
  // widen instead of hammering. Range 1-10; 1 disables widening (fixed
  // interval). 2 => 1x, 2x, 4x, 8x the interval between attempts.
  health_watch_backoff_factor: z.number().min(1).max(10).default(2),
  // How long a native addon's launch waits for its declared port to be released
  // by the previous holder before giving up. Range 1000-60000. A signalled
  // process does not release a listening socket instantly, and launching onto a
  // still-held port is what made both native addons die on EADDRINUSE on every
  // boot. Halfway through this budget a holder that is OURS (recorded in
  // ~/.sentient/run/<svc>.pid) is escalated from SIGTERM to SIGKILL; a holder
  // that cannot be identified as ours is never signalled, only named.
  native_port_settle_timeout_ms: z.number().int().min(1000).max(60000).default(8000),
  // How often the port is re-checked while waiting above. Range 50-5000. Each
  // check costs one `lsof`, so smaller values buy responsiveness at process cost.
  native_port_settle_poll_ms: z.number().int().min(50).max(5000).default(250),
});

export type SystemOrchestratorConfig = z.output<typeof systemOrchestratorConfigSchema>;
