/**
 * Browser-side tagged logger. Matches the shape of the gateway's
 * `gateway/src/logging/logger.ts` `Log` interface so call sites read the
 * same way on both sides of the wire.
 *
 * Tags are rendered as dot-separated prefix. Properties are logged as a
 * structured object (visible in browser devtools as expandable). Avoid
 * dumping secrets or raw tokens — mirror the sanitization discipline the
 * gateway logger enforces.
 */

export interface Log {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warn(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

export function createLogger(tags: readonly string[]): Log {
  const prefix = `[${tags.join(".")}]`;
  return {
    debug(msg, props) {
      if (props) console.debug(prefix, msg, props);
      else console.debug(prefix, msg);
    },
    info(msg, props) {
      if (props) console.info(prefix, msg, props);
      else console.info(prefix, msg);
    },
    warn(msg, props) {
      if (props) console.warn(prefix, msg, props);
      else console.warn(prefix, msg);
    },
    error(msg, props) {
      if (props) console.error(prefix, msg, props);
      else console.error(prefix, msg);
    },
  };
}
