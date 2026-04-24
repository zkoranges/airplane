import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getConfig,
  isGloballyPaused,
  setGloballyPaused,
  setRepoPaused,
  findRepo,
} from "./config";
import { streamChat } from "./chat";
import { tailLog } from "./log";
import { fixerManual, killCurrentFixer } from "./fixer";
import { killCurrentReviewer } from "./reviewer";
import {
  AIRPLANE_LABEL,
  BLOCKED_LABEL,
  FAILED_LABEL,
  FIXING_LABEL,
  REVIEW_LABEL,
  listIssuesByLabel,
} from "./github";

const UI_PATH = resolve(import.meta.dir, "ui.html");

export function buildApp() {
  const app = new Hono();

  app.get("/", (c) => {
    const html = readFileSync(UI_PATH, "utf8");
    return c.html(html);
  });

  app.get("/repos", (c) => {
    const cfg = getConfig();
    return c.json({
      paused: isGloballyPaused(),
      repos: cfg.repos.map((r) => ({ name: r.name, paused: !!r.paused, defaultBranch: r.defaultBranch })),
    });
  });

  app.get("/issues", async (c) => {
    const cfg = getConfig();
    const out: any[] = [];
    for (const repo of cfg.repos) {
      for (const label of [AIRPLANE_LABEL, FIXING_LABEL, REVIEW_LABEL, BLOCKED_LABEL, FAILED_LABEL]) {
        try {
          const issues = await listIssuesByLabel(repo.path, label);
          for (const i of issues) {
            out.push({
              repo: repo.name,
              number: i.number,
              title: i.title,
              labels: i.labels,
              url: `https://github.com/${await ownerRepo(repo.path)}/issues/${i.number}`,
            });
          }
        } catch {}
      }
    }
    // De-dupe by repo#num
    const seen = new Set<string>();
    const uniq = out.filter((i) => {
      const k = `${i.repo}#${i.number}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return c.json({ issues: uniq });
  });

  app.get("/chat", (c) => {
    const repoName = c.req.query("repo") || "";
    const message = c.req.query("message") || "";
    const repo = findRepo(repoName);
    if (!repo) return c.text(`unknown repo: ${repoName}`, 400);
    if (!message) return c.text("missing message", 400);

    return streamSSE(c, async (stream) => {
      let done = false;
      const h = streamChat(repo, message, (chunk) => {
        stream.writeSSE({ event: "chunk", data: chunk });
      });
      h.done.then(() => {
        done = true;
        stream.writeSSE({ event: "done", data: "ok" }).catch(() => {});
        stream.close();
      });
      stream.onAbort(() => {
        if (!done) h.kill();
      });
      await h.done;
    });
  });

  app.post("/fix/:repo/:num", async (c) => {
    const repoName = c.req.param("repo");
    const num = parseInt(c.req.param("num"), 10);
    if (!Number.isFinite(num)) return c.json({ ok: false, error: "bad issue number" }, 400);
    // Fire and forget so the HTTP call doesn't hang for 15 minutes
    fixerManual(repoName, num).catch(() => {});
    return c.json({ ok: true, queued: true });
  });

  app.post("/pause", (c) => {
    setGloballyPaused(true);
    return c.json({ ok: true, paused: true });
  });
  app.post("/resume", (c) => {
    setGloballyPaused(false);
    return c.json({ ok: true, paused: false });
  });

  app.post("/pause/:repo", (c) => {
    const ok = setRepoPaused(c.req.param("repo"), true);
    return c.json({ ok });
  });
  app.post("/resume/:repo", (c) => {
    const ok = setRepoPaused(c.req.param("repo"), false);
    return c.json({ ok });
  });

  app.post("/kill", (c) => {
    setGloballyPaused(true);
    killCurrentFixer();
    killCurrentReviewer();
    return c.json({ ok: true });
  });

  app.get("/log", (c) => {
    return streamSSE(c, async (stream) => {
      const watcher = tailLog((line) => {
        stream.writeSSE({ data: line }).catch(() => {});
      });
      stream.onAbort(() => watcher.close());
      // Keep stream open
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    });
  });

  return app;
}

async function ownerRepo(cwd: string): Promise<string> {
  const cached = ownerRepoCache.get(cwd);
  if (cached) return cached;
  try {
    const { run } = await import("./run");
    const r = await run("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd });
    if (r.code === 0) {
      const v = JSON.parse(r.stdout).nameWithOwner as string;
      ownerRepoCache.set(cwd, v);
      return v;
    }
  } catch {}
  return "unknown/unknown";
}
const ownerRepoCache = new Map<string, string>();
