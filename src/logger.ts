/**
 * Structured logging via LogTape — the logging facade Fedify itself uses,
 * so framework internals and app code share one consistent output.
 * Console output only; ./run-bg.sh redirects stdout to a log file.
 */
import {
  configure,
  getConsoleSink,
  getLogger,
  type LogRecord,
  type TextFormatter,
} from "@logtape/logtape";
import { config } from "./config.js";

const LEVELS = ["debug", "info", "warning", "error", "fatal"] as const;

/** Compact single-line formatter with an ISO timestamp and category. */
const lineFormatter: TextFormatter = (record: LogRecord) => {
  const ts = new Date().toISOString();
  const level = record.level.toUpperCase().padEnd(7, " ");
  const cat = record.category.join(".");
  return `${ts} ${level} [${cat}] ${record.message}\n`;
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
      { category: "logtape", sinks: ["console"] },
    ],
  });
}

export function appLog(category: string) {
  return getLogger(["mayaspace", category]);
}