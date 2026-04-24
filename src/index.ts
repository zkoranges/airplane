import { serve } from "bun";
import { buildApp } from "./server";
import { loadConfig, watchConfig, getConfig, isGloballyPaused } from "./config";
import { log } from "./log";
import { startupChecks, startupRecovery } from "./startup";
import { acquireLock } from "./lockfile";
import { fixerTick, killCurrentFixer } from "./fixer";
import { reviewerTick, killCurrentReviewer } from "./reviewer";
import { cleanupTick } from "./cleanup";

const lock = acquireLock();
if (!lock.ok) {
  console.error(`airplane is already running (pid ${lock.pid}). Exiting.`);
  process.exit(1);
}

await loadConfig();
watchConfig();

const checks = await startupChecks();
if (!checks.ok) {
  for (const e of checks.errors) log("startup.error", { error: e });
  console.error("Startup checks failed:\n" + checks.errors.join("\n"));
  process.exit(1);
}
log("startup.checks.ok");

await startupRecovery();

const cfg = getConfig();
process.env.AIRPLANE_PORT = String(cfg.port);

const app = buildApp();
const server = serve({
  port: cfg.port,
  hostname: "0.0.0.0",
  // SSE streams (chat, log) hold the connection open well past Bun's 10s default.
  idleTimeout: 0,
  fetch: app.fetch,
});
log("server.listen", { port: server.port });

let ticking = false;
async function tick() {
  if (ticking) return;
  if (isGloballyPaused()) return;
  ticking = true;
  try {
    await fixerTick();
    await reviewerTick();
    await cleanupTick();
  } catch (e: any) {
    log("tick.error", { error: String(e?.message ?? e) });
  } finally {
    ticking = false;
  }
}

// Kick an initial tick shortly after start, then on the configured interval.
setTimeout(() => {
  tick();
}, 5_000);
setInterval(tick, cfg.fixerIntervalMs);

log("startup.ready", { port: server.port, repos: cfg.repos.length, intervalMs: cfg.fixerIntervalMs });

process.on("unhandledRejection", (err) => {
  log("unhandled.rejection", { error: String((err as any)?.message ?? err) });
});
process.on("uncaughtException", (err) => {
  log("uncaught.exception", { error: String(err?.message ?? err) });
});

// On graceful shutdown: kill any running Claude child first so we don't
// leave orphans, then exit (lockfile cleanup runs on `exit`).
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown", { signal: sig });
    try { killCurrentFixer(); } catch {}
    try { killCurrentReviewer(); } catch {}
    process.exit(sig === "SIGINT" ? 130 : 143);
  });
}
