import { run } from "./run";
import { log } from "./log";
import { ghCheckAuth, ensureLabels, listIssuesByLabel, swapLabel, AIRPLANE_LABEL, FIXING_LABEL } from "./github";
import { claudeCheckPresent } from "./claude";
import { getConfig } from "./config";
import { pruneOrphanWorktrees } from "./cleanup";

export async function startupChecks(): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (const bin of ["git", "gh", "claude"]) {
    const r = await run("which", [bin]);
    if (r.code !== 0) errors.push(`missing binary on PATH: ${bin}`);
  }

  if (!(await claudeCheckPresent())) errors.push("claude --version failed");

  const auth = await ghCheckAuth();
  if (!auth.ok) errors.push(`gh auth not ready:\n${auth.message}`);

  const cfg = getConfig();
  for (const repo of cfg.repos) {
    const r = await run("git", ["rev-parse", "--git-dir"], { cwd: repo.path });
    if (r.code !== 0) errors.push(`repo ${repo.name} at ${repo.path} is not a git repo`);
  }

  return { ok: errors.length === 0, errors };
}

export async function startupRecovery(): Promise<void> {
  const cfg = getConfig();

  // Reset :fixing back to airplane (all of them at startup).
  for (const repo of cfg.repos) {
    try {
      await ensureLabels(repo.path);
    } catch (e: any) {
      log("startup.labels.error", { repo: repo.name, error: String(e?.message ?? e) });
    }
    try {
      const stuck = await listIssuesByLabel(repo.path, FIXING_LABEL);
      for (const i of stuck) {
        try {
          await swapLabel(repo.path, i.number, AIRPLANE_LABEL, FIXING_LABEL);
          log("startup.reset", { repo: repo.name, issue: i.number });
        } catch (e: any) {
          log("startup.reset.error", {
            repo: repo.name,
            issue: i.number,
            error: String(e?.message ?? e),
          });
        }
      }
    } catch (e: any) {
      log("startup.list.error", { repo: repo.name, error: String(e?.message ?? e) });
    }
  }

  // Prune orphan worktrees
  try {
    await pruneOrphanWorktrees();
  } catch (e: any) {
    log("startup.prune.error", { error: String(e?.message ?? e) });
  }
}
