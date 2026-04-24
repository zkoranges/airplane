import { run } from "./run";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "issue";
}

export function branchName(issueNum: number, title: string): string {
  return `airplane/issue-${issueNum}-${slugify(title)}`;
}

export function worktreePath(worktreeDir: string, repoName: string, issueNum: number): string {
  return join(worktreeDir, repoName, String(issueNum));
}

export async function pullDefault(cwd: string, defaultBranch: string) {
  // Don't force — just fetch + update ref. We create worktrees off origin/<default>.
  await run("git", ["fetch", "origin", defaultBranch], { cwd });
}

export async function createWorktree(repoPath: string, wtPath: string, branch: string, base: string) {
  // Clean up any previous worktree at this path
  if (existsSync(wtPath)) {
    await run("git", ["worktree", "remove", "--force", wtPath], { cwd: repoPath });
  }
  // Ensure the new branch doesn't already exist
  await run("git", ["branch", "-D", branch], { cwd: repoPath });
  const r = await run(
    "git",
    ["worktree", "add", "-b", branch, wtPath, `origin/${base}`],
    { cwd: repoPath }
  );
  if (r.code !== 0) {
    // fallback: try from local base
    const r2 = await run("git", ["worktree", "add", "-b", branch, wtPath, base], { cwd: repoPath });
    if (r2.code !== 0) throw new Error(`worktree add failed: ${r.stderr}\n${r2.stderr}`);
  }
}

export async function removeWorktree(repoPath: string, wtPath: string) {
  if (!existsSync(wtPath)) return;
  await run("git", ["worktree", "remove", "--force", wtPath], { cwd: repoPath });
}

export async function pruneWorktrees(repoPath: string) {
  await run("git", ["worktree", "prune"], { cwd: repoPath });
}

export async function hasNewCommits(wtPath: string, base: string): Promise<boolean> {
  const r = await run("git", ["rev-list", "--count", `origin/${base}..HEAD`], { cwd: wtPath });
  if (r.code !== 0) return false;
  return parseInt(r.stdout.trim() || "0", 10) > 0;
}

export async function currentBranch(wtPath: string): Promise<string> {
  const r = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath });
  return r.stdout.trim();
}

export async function deleteBranch(repoPath: string, branch: string) {
  await run("git", ["branch", "-D", branch], { cwd: repoPath });
}

export async function pushBranch(wtPath: string, branch: string): Promise<boolean> {
  const r = await run("git", ["push", "-u", "origin", branch], { cwd: wtPath });
  return r.code === 0;
}
