/**
 * Structured logging via LogTape — the logging facade Fedify itself uses,
 * so framework internals and app code share one consistent output.
 * Console output only; ./run-bg.sh redirects stdout to a log file.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  configure,
  getConsoleSink,
  getLogger,
  type LogRecord,
  type TextFormatter,
} from "@logtape/logtape";
import { config } from "./config.js";

const LEVELS = ["debug", "info", "warning", "error", "fatal"] as const;

/**
 * Renders a substituted log value readably: strings verbatim, errors with
 * stacks, everything else as JSON. LogTape message arrays interleave template
 * text with values, so `[object Object]`-style artifacts come from values that
 * need this treatment (e.g. fedify's fetch-failure header objects).
 */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Compact single-line formatter with an ISO timestamp and category. */
const lineFormatter: TextFormatter = (record: LogRecord) => {
  const ts = new Date(record.timestamp).toISOString();
  const level = record.level.toUpperCase().padEnd(7, " ");
  const cat = record.category.join(".");
  const message = record.message.map(renderValue).join("");
  // Structured properties (e.g. fedify's signature-verification failure
  // reason/keyId) are appended as JSON so failures stay diagnosable.
  const props =
    Object.keys(record.properties).length > 0 ? ` ${JSON.stringify(record.properties)}` : "";
  return `${ts} ${level} [${cat}] ${message}${props}\n`;
};

export async function configureLogging(): Promise<void> {
  const minIndex = Math.max(0, LEVELS.indexOf(config.logLevel as (typeof LEVELS)[number]));
  const allowed = new Set(LEVELS.slice(minIndex));
  await configure({
    sinks: {
      console: getConsoleSink({
        formatter: lineFormatter,
      }),
    },
    filters: {
      level: (record) =>
        allowed.has(record.level as Exclude<(typeof LEVELS)[number], "trace">),
    },
    loggers: [
      { category: "mayaspace", sinks: ["console"] },
      { category: "fedify", sinks: ["console"], filters: ["level"] },
      { category: "logtape", sinks: ["console"], filters: ["level"] },
    ],
    // LogTape's implicit-context API (used by fedify) warns on every use when
    // no context-local storage is configured; provide one so requests can also
    // carry implicit log context.
    contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
  });
}

export function appLog(category: string) {
  return getLogger(["mayaspace", category]);
}