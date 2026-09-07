/**
 * In-process asynchronous background scheduler. Jobs are plain async
 * functions run on an interval with overlap protection and error capture —
 * no external cron/queue dependency required.
 */
import { appLog } from "./logger.js";

const log = appLog("scheduler");

interface ScheduledJob {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
  timer: NodeJS.Timeout | null;
  running: boolean;
  lastError: string | null;
  lastRunAt: number | null;
}

const jobs = new Map<string, ScheduledJob>();

/**
 * Registers (or replaces) a named recurring job. The first run waits one
 * interval so boot is never delayed.
 */
export function registerJob(name: string, intervalMs: number, fn: () => Promise<void>): void {
  const existing = jobs.get(name);
  if (existing?.timer) clearTimeout(existing.timer);
  jobs.set(name, { name, intervalMs, fn, timer: null, running: false, lastError: null, lastRunAt: null });
  log.debug`Registered background job ${name} (every ${intervalMs} ms)`;
}

async function runJob(job: ScheduledJob): Promise<void> {
  if (job.running) {
    log.debug`Job ${job.name} still running — skipping this tick`;
    return;
  }
  job.running = true;
  const started = Date.now();
  try {
    await job.fn();
    job.lastRunAt = started;
    job.lastError = null;
    log.debug`Job ${job.name} finished in ${Date.now() - started} ms`;
  } catch (err) {
    job.lastError = err instanceof Error ? err.message : String(err);
    log.error`Job ${job.name} failed: ${err}`;
  } finally {
    job.running = false;
  }
}

export function startScheduler(): void {
  for (const job of jobs.values()) {
    if (job.timer) continue;
    job.timer = setInterval(() => {
      void runJob(job);
    }, job.intervalMs);
    job.timer.unref();
  }
  log.info`Background scheduler started with ${jobs.size} job(s)`;
}

export function stopScheduler(): void {
  for (const job of jobs.values()) {
    if (job.timer) {
      clearInterval(job.timer);
      job.timer = null;
    }
  }
  log.info`Background scheduler stopped`;
}

/** Triggers one job immediately (used by admin actions like "purge cache"). */
export async function runJobNow(name: string): Promise<void> {
  const job = jobs.get(name);
  if (!job) throw new Error(`No such job: ${name}`);
  await runJob(job);
}

export function schedulerStatus(): Array<{
  name: string;
  intervalMs: number;
  running: boolean;
  lastRunAt: number | null;
  lastError: string | null;
}> {
  return Array.from(jobs.values()).map((j) => ({
    name: j.name,
    intervalMs: j.intervalMs,
    running: j.running,
    lastRunAt: j.lastRunAt,
    lastError: j.lastError,
  }));
}