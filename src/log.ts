import { appendFileSync, createReadStream, existsSync, statSync, watch } from "node:fs";
import { resolve } from "node:path";

const LOG_PATH = resolve(process.cwd(), "airplane.log");

export function logPath() {
  return LOG_PATH;
}

function ts() {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function log(event: string, data?: Record<string, unknown>) {
  const line =
    data && Object.keys(data).length
      ? `[${ts()}] ${event} ${JSON.stringify(data)}\n`
      : `[${ts()}] ${event}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // best effort
  }
  process.stdout.write(line);
}

export type LogWatcher = {
  close: () => void;
};

// Tail the log file, calling onLine for every appended line. Also emits existing tail.
export function tailLog(onLine: (line: string) => void, tailBytes = 16 * 1024): LogWatcher {
  let pos = 0;
  if (existsSync(LOG_PATH)) {
    const size = statSync(LOG_PATH).size;
    pos = Math.max(0, size - tailBytes);
    const rs = createReadStream(LOG_PATH, { start: pos, end: size - 1, encoding: "utf8" });
    let buf = "";
    rs.on("data", (chunk) => {
      buf += chunk;
    });
    rs.on("end", () => {
      for (const l of buf.split("\n")) if (l) onLine(l);
      pos = size;
      startWatching();
    });
    rs.on("error", () => startWatching());
  } else {
    startWatching();
  }

  let watcher: ReturnType<typeof watch> | null = null;
  let closed = false;
  let pending = "";

  function startWatching() {
    if (closed) return;
    try {
      watcher = watch(LOG_PATH, { persistent: false }, () => {
        if (!existsSync(LOG_PATH)) return;
        const size = statSync(LOG_PATH).size;
        if (size < pos) pos = 0; // truncated
        if (size > pos) {
          const rs = createReadStream(LOG_PATH, { start: pos, end: size - 1, encoding: "utf8" });
          rs.on("data", (chunk) => {
            pending += chunk;
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            for (const p of parts) if (p) onLine(p);
          });
          rs.on("end", () => {
            pos = size;
          });
        }
      });
    } catch {
      // file may not exist yet; poll lazily
      setTimeout(startWatching, 1000);
    }
  }

  return {
    close() {
      closed = true;
      watcher?.close();
    },
  };
}
