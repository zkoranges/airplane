import { watch } from "chokidar";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { log } from "./log";

export type RepoConfig = {
  name: string; // slug used in paths, e.g. "myrepo"
  path: string; // absolute local path
  defaultBranch: string; // e.g. "main"
  paused?: boolean;
};

export type AirplaneConfig = {
  repos: RepoConfig[];
  fixerIntervalMs?: number; // default 5 minutes
  fixerTimeoutMs?: number; // default 15 minutes
  port?: number; // default 4242
  staleFixingMs?: number; // default 30 minutes — reset :fixing labels older than this
  worktreeDir?: string; // default .airplane/worktrees
};

const CONFIG_FILE = resolve(process.cwd(), "airplane.config.ts");

let current: AirplaneConfig = { repos: [] };
let globalPaused = false;

export function getConfig(): AirplaneConfig {
  return current;
}

export function isGloballyPaused(): boolean {
  return globalPaused;
}

export function setGloballyPaused(v: boolean) {
  globalPaused = v;
  log("pause.global", { paused: v });
}

export function setRepoPaused(name: string, paused: boolean): boolean {
  const r = current.repos.find((x) => x.name === name);
  if (!r) return false;
  r.paused = paused;
  log("pause.repo", { repo: name, paused });
  return true;
}

export function findRepo(name: string): RepoConfig | undefined {
  return current.repos.find((r) => r.name === name);
}

async function loadOnce(): Promise<AirplaneConfig> {
  // Bun's ESM cache holds imports by URL even with ?t= suffixes, so a true
  // reload requires a brand-new module URL. Copy the file to a unique path
  // *inside the project root* so any relative imports it has (e.g. `import
  // type ... from "./src/config"`) still resolve.
  const src = readFileSync(CONFIG_FILE, "utf8");
  const stageDir = resolve(process.cwd(), ".airplane/config-stage");
  mkdirSync(stageDir, { recursive: true });
  // best-effort cleanup of older stages
  try {
    for (const f of readdirSync(stageDir)) {
      try {
        unlinkSync(join(stageDir, f));
      } catch {}
    }
  } catch {}
  // The stage file lives one directory deeper than the original
  // (.airplane/config-stage/foo.ts vs ./airplane.config.ts), so rewrite
  // any `./src/...` relative imports up one level so they still resolve.
  const rewritten = src.replace(/(["'])\.\/(src\/)/g, "$1../../$2");
  const tmp = join(stageDir, `cfg-${Date.now()}-${process.pid}.ts`);
  writeFileSync(tmp, rewritten);
  const mod = await import(pathToFileURL(tmp).href);
  const cfg: AirplaneConfig = mod.default ?? mod.config;
  if (!cfg || !Array.isArray(cfg.repos)) {
    throw new Error("airplane.config.ts must export default { repos: [...] }");
  }
  // normalize
  for (const r of cfg.repos) {
    r.path = resolve(r.path);
    r.defaultBranch = r.defaultBranch || "main";
    r.paused = !!r.paused;
    if (!r.name) throw new Error(`repo missing name: ${r.path}`);
  }
  cfg.fixerIntervalMs = cfg.fixerIntervalMs ?? 5 * 60 * 1000;
  cfg.fixerTimeoutMs = cfg.fixerTimeoutMs ?? 15 * 60 * 1000;
  cfg.port = cfg.port ?? 4242;
  cfg.staleFixingMs = cfg.staleFixingMs ?? 30 * 60 * 1000;
  cfg.worktreeDir = resolve(cfg.worktreeDir ?? ".airplane/worktrees");
  return cfg;
}

export async function loadConfig(): Promise<AirplaneConfig> {
  current = await loadOnce();
  log("config.loaded", { repos: current.repos.length });
  return current;
}

export function watchConfig() {
  const w = watch(CONFIG_FILE, { ignoreInitial: true });
  w.on("change", async () => {
    try {
      const next = await loadOnce();
      current = next;
      log("config.reloaded", { repos: current.repos.length });
    } catch (e: any) {
      log("config.reload.error", { error: String(e?.message ?? e) });
    }
  });
  return w;
}
