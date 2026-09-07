/**
 * MayaSpace entry point: logging → store → federation context → background
 * scheduler jobs → HTTP server, with graceful shutdown.
 */
import { createApp } from "./app.js";
import { config } from "./config.js";
import { appLog, configureLogging } from "./logger.js";
import { store } from "./store.js";
import { registerJob, startScheduler, stopScheduler } from "./scheduler.js";
import { purgeOrphanAttachments } from "./services/attachments.js";

const HOUR = 60 * 60 * 1000;

async function main(): Promise<void> {
  await configureLogging();
  const log = appLog("main");

  await store.init();
  const { app, federation } = await createApp();

  // Drain the persisted delivery queue (outbox retries + inbox processing).
  void federation.startQueue(null).catch((err) => {
    log.error`Federation queue failed to start: ${err}`;
  });

  // Background jobs (in-process async scheduler).
  registerJob("purge-attachments", 6 * HOUR, async () => {
    // Uploads not attached within 24h are discarded.
    await purgeOrphanAttachments(24 * HOUR);
  });
  registerJob("prune-notifications", 24 * HOUR, async () => {
    await store.pruneNotifications(90 * 24 * HOUR);
  });
  startScheduler();

  const server = app.listen(config.port, () => {
    log.info`MayaSpace listening on port ${config.port} (${config.mayaUrl})`;
    log.info`Site: ${config.siteName} — ${config.siteTagline}`;
  });
  server.keepAliveTimeout = 65_000;

  const shutdown = (signal: string): void => {
    log.info`Received ${signal} — shutting down…`;
    stopScheduler();
    server.close(() => {
      log.info`HTTP server closed. Goodbye!`;
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error`Unhandled rejection: ${reason}`;
  });
}

main().catch((err) => {
  console.error("[fatal] MayaSpace failed to start:", err);
  process.exit(1);
});