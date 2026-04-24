import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PID_FILE = resolve(process.cwd(), ".airplane/airplane.pid");

function ensureDir() {
  const dir = resolve(process.cwd(), ".airplane");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function acquireLock(): { ok: boolean; pid?: number } {
  ensureDir();
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (Number.isFinite(pid) && isAlive(pid)) {
      return { ok: false, pid };
    }
    // stale
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }
  writeFileSync(PID_FILE, String(process.pid));
  // Only register an `exit` cleanup here. SIGINT/SIGTERM are handled by
  // index.ts so it can sequence killing in-flight children before we exit.
  process.on("exit", () => {
    try {
      if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
        unlinkSync(PID_FILE);
      }
    } catch {}
  });
  return { ok: true };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}
