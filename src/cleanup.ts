import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  closeIssue,
  extractIssueNumbersFromText,
  getPRBody,
  listMergedAirplanePRs,
} from "./github";
import { getConfig } from "./config";
import { deleteBranch, pruneWorktrees, removeWorktree } from "./git";
import { log } from "./log";
import { run } from "./run";

const seenMerged = new Set<string>(); // `${repo}#${pr}`

export async function cleanupTick(): Promise<void> {
  const cfg = getConfig();
  for (const repo of cfg.repos) {
    if (repo.paused) continue;
    let merged;
    try {
      merged = await listMergedAirplanePRs(repo.path);
    } catch (e: any) {
      log("cleanup.list.error", { repo: repo.name, error: String(e?.message ?? e) });
      continue;
    }
    for (const pr of merged) {
      const key = `${repo.name}#${pr.number}`;
      if (seenMerged.has(key)) continue;
      seenMerged.add(key);

      // Extract issue numbers and close them if still open
      let body = "";
      try {
        body = await getPRBody(repo.path, pr.number);
      } catch {}
      const issueNums = extractIssueNumbersFromText(body);
      for (const n of issueNums) {
        try {
          await closeIssue(repo.path, n);
        } catch {}
      }

      // Determine worktree path from branch name: airplane/issue-<N>-<slug>
      const m = /^airplane\/issue-(\d+)-/.exec(pr.headRefName);
      if (m) {
        const issueNum = parseInt(m[1]!, 10);
        const wt = join(cfg.worktreeDir!, repo.name, String(issueNum));
        try {
          await removeWorktree(repo.path, wt);
        } catch {}
      }

      try {
        await deleteBranch(repo.path, pr.headRefName);
      } catch {}
      // Delete remote branch too (best-effort)
      try {
        await run("git", ["push", "origin", "--delete", pr.headRefName], { cwd: repo.path });
      } catch {}

      log("cleanup.merged", { repo: repo.name, pr: pr.number, branch: pr.headRefName });
    }

    // Prune any stale worktree registration
    try {
      await pruneWorktrees(repo.path);
    } catch {}
  }
}

// Runs once at startup: remove any orphan worktrees and reset :fixing
export async function pruneOrphanWorktrees(): Promise<void> {
  const cfg = getConfig();
  const dir = cfg.worktreeDir!;
  if (!existsSync(dir)) return;
  for (const repo of cfg.repos) {
    const repoDir = join(dir, repo.name);
    if (!existsSync(repoDir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(repoDir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const wt = join(repoDir, e);
      try {
        if (!statSync(wt).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        await removeWorktree(repo.path, wt);
        log("cleanup.orphan.removed", { repo: repo.name, worktree: wt });
      } catch (err: any) {
        log("cleanup.orphan.error", { worktree: wt, error: String(err?.message ?? err) });
      }
    }
    try {
      await pruneWorktrees(repo.path);
    } catch {}
  }
}
