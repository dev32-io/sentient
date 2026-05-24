import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type LogLevel, type LogRecord, type Sink, configure, getLogger, parseLogLevel } from "@logtape/logtape";
import { formatLocalDate, formatLogEntry } from "./format.js";
import { sanitizeMessage, sanitizeProperties } from "./log-sanitizer.js";
import { pruneOldLogs } from "./prune.js";

const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_LOG_DIR = "logs";

export interface GatewayLoggerOptions {
  logLevel?: string;
  enableFile?: boolean;
  logDir?: string;
  retentionDays?: number;
  testSink?: (line: string) => void;
  /**
   * Per-category level overrides. Keys are colon-joined LogTape category
   * paths (e.g. "sentient:cerebrum:hermes-event-translator"). Categories
   * not listed inherit `logLevel`. Used to flip debug on for a specific
   * path without bumping the whole gateway to debug.
   */
  levelOverrides?: Record<string, string>;
}

export interface Log {
  debug: (message: string, properties?: Record<string, unknown>) => void;
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn: (message: string, properties?: Record<string, unknown>) => void;
  error: (message: string, properties?: Record<string, unknown>) => void;
}

/**
 * Extracts a plain message string from a LogRecord's rawMessage.
 */
function extractMessage(record: LogRecord): string {
  if (typeof record.rawMessage === "string") {
    return record.rawMessage;
  }
  return record.message.map(String).join("");
}

/**
 * Simple daily-rotating file sink using our own formatter.
 * Ensures structured properties (key=value) are always written to the log file.
 * Triggers a fire-and-forget prune on actual midnight rollovers (not first write).
 */
function createDailyFileSink(logDir: string, retentionDays: number): Sink {
  mkdirSync(logDir, { recursive: true });
  let currentDate = "";
  let currentPath = "";

  return (record: LogRecord) => {
    const message = sanitizeMessage(extractMessage(record));
    const properties = sanitizeProperties(record.properties);
    const line = formatLogEntry({
      level: record.level,
      category: record.category,
      message,
      timestamp: new Date(record.timestamp),
      properties,
    });

    const date = formatLocalDate(new Date(record.timestamp));
    if (date !== currentDate) {
      const isRollover = currentDate !== "";
      currentDate = date;
      currentPath = join(logDir, `${date}.log`);
      if (isRollover) {
        // Fire-and-forget; never block the write path. The prune helper
        // already swallows per-file errors.
        pruneOldLogs(logDir, retentionDays).catch(() => {
          // Pruning failure must never break logging itself.
        });
      }
    }
    appendFileSync(currentPath, `${line}\n`);
  };
}

/**
 * Creates a Sink that formats + sanitizes log records and writes
 * the resulting line to the provided output function.
 */
function createFormattedSink(output: (line: string) => void): Sink {
  return (record: LogRecord) => {
    const message = sanitizeMessage(extractMessage(record));
    const properties = sanitizeProperties(record.properties);

    const line = formatLogEntry({
      level: record.level,
      category: record.category,
      message,
      timestamp: new Date(record.timestamp),
      properties,
    });

    output(line);
  };
}

/**
 * Configures LogTape with console sink (stderr) and optional file sink.
 * Uses the formatter and sanitizer for all output.
 */
export async function createGatewayLogger(options: GatewayLoggerOptions = {}): Promise<void> {
  const levelStr = options.logLevel ?? DEFAULT_LOG_LEVEL;
  const level = parseLogLevel(levelStr.toLowerCase()) as LogLevel;
  const retentionDays = options.retentionDays ?? 7;

  const sinks: Record<string, Sink> = {};

  if (options.testSink) {
    sinks.test = createFormattedSink(options.testSink);
  } else {
    sinks.console = createFormattedSink((line) => {
      process.stderr.write(`${line}\n`);
    });
  }

  if (options.enableFile) {
    const logDir = options.logDir ?? DEFAULT_LOG_DIR;
    sinks.file = createDailyFileSink(logDir, retentionDays);
    // Startup prune — runs once before any rollover can occur. Awaited
    // so we know the dir is consistent before the first log write.
    await pruneOldLogs(logDir, retentionDays);
  }

  const sinkIds = Object.keys(sinks) as string[];

  const overrides = options.levelOverrides ?? {};
  const overrideLoggers = Object.entries(overrides).map(([key, lvl]) => ({
    category: key.split(":"),
    sinks: sinkIds,
    lowestLevel: parseLogLevel(lvl.toLowerCase()) as LogLevel,
  }));

  await configure({
    sinks,
    loggers: [
      {
        category: "sentient",
        sinks: sinkIds,
        lowestLevel: level,
      },
      {
        category: "logtape",
        sinks: sinkIds,
        lowestLevel: "error",
      },
      ...overrideLoggers,
    ],
    reset: true,
  });
}

/**
 * Returns a logger with a simplified interface.
 * Category array maps to a LogTape logger under the hood.
 */
export function getLog(category: string[]): Log {
  const logger = getLogger(category);

  return {
    debug: (message, properties) => logger.debug(message, properties ?? {}),
    info: (message, properties) => logger.info(message, properties ?? {}),
    warn: (message, properties) => logger.warn(message, properties ?? {}),
    error: (message, properties) => logger.error(message, properties ?? {}),
  };
}
