// UI-managed repo store. Persisted to .airplane/repos.json, merged on top of
// the static airplane.config.ts repos. Each entry here corresponds to a repo
// the user added through the UI.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { RepoConfig } from "./config";
import { run } from "./run";

const STORE = resolve(process.cwd(), ".airplane/repos.json");

type Stored = {
  name: string;
  path: string;
  defaultBranch: string;
  paused?: boolean;
};

function ensureDir() {
  const dir = resolve(process.cwd(), ".airplane");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readAll(): Stored[] {
  if (!existsSync(STORE)) return [];
  try {
    const raw = JSON.parse(readFileSync(STORE, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r) => r && typeof r.name === "string" && typeof r.path === "string" && typeof r.defaultBranch === "string"
    );
  } catch {
    return [];
  }
}

function writeAll(rows: Stored[]) {
  ensureDir();
  writeFileSync(STORE, JSON.stringify(rows, null, 2));
}

export function loadDynamic(): RepoConfig[] {
  return readAll().map((r) => ({
    name: r.name,
    path: resolve(r.path),
    defaultBranch: r.defaultBranch,
    paused: !!r.paused,
  }));
}

export function listDynamicNames(): Set<string> {
  return new Set(readAll().map((r) => r.name));
}

export type AddInput = { path: string; name?: string; defaultBranch?: string };
export type AddResult =
  | { ok: true; repo: RepoConfig; ownerRepo: string | null }
  | { ok: false; error: string };

function slugifyName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  // Try origin/HEAD first, then a fallback to local HEAD.
  const r1 = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoPath });
  if (r1.code === 0) {
    const out = r1.stdout.trim(); // e.g. "origin/main"
    const slash = out.indexOf("/");
    if (slash >= 0) return out.slice(slash + 1);
    return out;
  }
  const r2 = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath });
  if (r2.code === 0) {
    const b = r2.stdout.trim();
    if (b && b !== "HEAD") return b;
  }
  return null;
}

async function detectOwnerRepo(repoPath: string): Promise<string | null> {
  const r = await run("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: repoPath });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout).nameWithOwner ?? null;
  } catch {
    return null;
  }
}

export async function addDynamic(
  input: AddInput,
  takenNames: Set<string>
): Promise<AddResult> {
  const path = input.path?.trim();
  if (!path) return { ok: false, error: "path is required" };
  if (!path.startsWith("/") && !/^[a-z]:[\\/]/i.test(path)) {
    return { ok: false, error: "path must be absolute" };
  }
  let st;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, error: `path does not exist: ${path}` };
  }
  if (!st.isDirectory()) return { ok: false, error: `not a directory: ${path}` };
  const gitCheck = await run("git", ["rev-parse", "--git-dir"], { cwd: path });
  if (gitCheck.code !== 0) return { ok: false, error: `not a git repo: ${path}` };

  let name = (input.name || basename(path)).trim();
  if (!name) name = "repo";
  name = slugifyName(name);
  if (!name) return { ok: false, error: "invalid name" };
  if (takenNames.has(name)) {
    // append a numeric suffix
    let i = 2;
    while (takenNames.has(`${name}-${i}`)) i++;
    name = `${name}-${i}`;
  }

  let defaultBranch = (input.defaultBranch || "").trim();
  if (!defaultBranch) {
    const detected = await detectDefaultBranch(path);
    if (!detected) return { ok: false, error: "could not detect default branch — please specify one" };
    defaultBranch = detected;
  }

  const ownerRepo = await detectOwnerRepo(path);

  const stored: Stored = { name, path: resolve(path), defaultBranch, paused: false };
  const rows = readAll();
  rows.push(stored);
  writeAll(rows);

  return {
    ok: true,
    repo: { name: stored.name, path: stored.path, defaultBranch: stored.defaultBranch, paused: false },
    ownerRepo,
  };
}

export function removeDynamic(name: string): { ok: boolean; error?: string } {
  const rows = readAll();
  const next = rows.filter((r) => r.name !== name);
  if (next.length === rows.length) return { ok: false, error: `not a UI-added repo: ${name}` };
  writeAll(next);
  return { ok: true };
}

export function setDynamicPaused(name: string, paused: boolean): boolean {
  const rows = readAll();
  const r = rows.find((x) => x.name === name);
  if (!r) return false;
  r.paused = paused;
  writeAll(rows);
  return true;
}
