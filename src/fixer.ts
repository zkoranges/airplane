import {
  AIRPLANE_LABEL,
  FIXING_LABEL,
  REVIEW_LABEL,
  FAILED_LABEL,
  AIRPLANE_COAUTHOR,
  addLabel,
  commentIssue,
  ensureLabels,
  getIssue,
  getIssueComments,
  listIssuesByLabel,
  listPRsForBranch,
  removeLabel,
  swapLabel,
  type Issue,
} from "./github";
import type { RepoConfig } from "./config";
import { getConfig, isGloballyPaused } from "./config";
import { branchName, createWorktree, hasNewCommits, pullDefault, worktreePath } from "./git";
import { claudeOneShot } from "./claude";
import { log } from "./log";

let running = false;
let currentChild: { kill: () => void } | null = null;

export function isFixerRunning(): boolean {
  return running;
}

export function killCurrentFixer() {
  currentChild?.kill();
}

function isAirplaneComment(c: { body: string; author: string }): boolean {
  // Filter out our own failure/context comments so they don't feed future attempts.
  if (/airplane/i.test(c.author)) return true;
  if (c.body.includes("<!-- airplane -->")) return true;
  if (c.body.startsWith("Airplane fixer failed")) return true;
  if (c.body.startsWith("Airplane reviewer")) return true;
  return false;
}

function fixerPrompt(repo: RepoConfig, issue: Issue, comments: { author: string; body: string }[], branch: string) {
  const cleanComments = comments.filter((c) => !isAirplaneComment(c));
  const commentsBlock = cleanComments.length
    ? cleanComments.map((c) => `--- @${c.author} ---\n${c.body}`).join("\n\n")
    : "(no comments)";
  return `You are Airplane's fixer agent. Fix GitHub issue #${issue.number} in this repo autonomously.

Issue title: ${issue.title}

Issue body:
${issue.body || "(empty)"}

Human comments on the issue:
${commentsBlock}

Working environment:
- You are on branch "${branch}" in a fresh git worktree (cwd).
- Repo default branch: ${repo.defaultBranch}
- You have full shell access. You may edit files, run tests, install deps, etc.
- You have gh CLI authenticated. You have git configured.

What you must do:
1. Implement the fix in this worktree.
2. Make at least one commit. Every commit message MUST include this trailer:
   ${AIRPLANE_COAUTHOR}
3. Push the branch: \`git push -u origin ${branch}\`
4. Open a pull request with \`gh pr create --fill --base ${repo.defaultBranch} --head ${branch}\` — the PR body MUST include "Closes #${issue.number}" so GitHub auto-closes the issue on merge.
5. If the fix is ambiguous or blocked on information you cannot resolve, do NOT open a PR. Instead exit without committing and explain why in your output.

Keep the change focused on this issue. Do not refactor unrelated code. Match existing style.

Begin.`;
}

async function pickNextIssue(repos: RepoConfig[]): Promise<{ repo: RepoConfig; issue: Issue } | null> {
  let best: { repo: RepoConfig; issue: Issue } | null = null;
  for (const repo of repos) {
    if (repo.paused) continue;
    let issues: Issue[] = [];
    try {
      issues = await listIssuesByLabel(repo.path, AIRPLANE_LABEL);
    } catch (e: any) {
      log("fixer.list.error", { repo: repo.name, error: String(e?.message ?? e) });
      continue;
    }
    for (const i of issues) {
      if (!best || i.number < best.issue.number) best = { repo, issue: i };
    }
  }
  return best;
}

export async function resetStaleFixing(repos: RepoConfig[], staleMs: number) {
  const cutoff = Date.now() - staleMs;
  for (const repo of repos) {
    let issues: Issue[] = [];
    try {
      issues = await listIssuesByLabel(repo.path, FIXING_LABEL);
    } catch {
      continue;
    }
    for (const i of issues) {
      const t = Date.parse(i.updatedAt);
      if (!Number.isFinite(t) || t < cutoff) {
        try {
          await swapLabel(repo.path, i.number, AIRPLANE_LABEL, FIXING_LABEL);
          log("fixer.stale.reset", { repo: repo.name, issue: i.number });
        } catch (e: any) {
          log("fixer.stale.reset.error", {
            repo: repo.name,
            issue: i.number,
            error: String(e?.message ?? e),
          });
        }
      }
    }
  }
}

async function runFixerOnce(repo: RepoConfig, issue: Issue): Promise<void> {
  const cfg = getConfig();
  const branch = branchName(issue.number, issue.title);
  const wt = worktreePath(cfg.worktreeDir!, repo.name, issue.number);

  // Claim
  try {
    await swapLabel(repo.path, issue.number, FIXING_LABEL, AIRPLANE_LABEL);
  } catch (e: any) {
    log("fixer.claim.failed", { repo: repo.name, issue: issue.number, error: String(e?.message ?? e) });
    return;
  }
  log("fixer.claimed", { repo: repo.name, issue: issue.number });

  try {
    await pullDefault(repo.path, repo.defaultBranch);
    await createWorktree(repo.path, wt, branch, repo.defaultBranch);

    const comments = await getIssueComments(repo.path, issue.number);
    const prompt = fixerPrompt(repo, issue, comments, branch);
    log("fixer.claude.start", { repo: repo.name, issue: issue.number, wt });

    const res = await claudeOneShot(wt, prompt, {
      timeoutMs: cfg.fixerTimeoutMs,
      onSpawn: (kill) => {
        currentChild = { kill };
      },
    });
    currentChild = null;
    log("fixer.claude.done", {
      repo: repo.name,
      issue: issue.number,
      code: res.code,
      timedOut: res.timedOut,
    });

    // Rate-limit detection: requeue back to airplane, no failure.
    const combined = (res.stdout + "\n" + res.stderr).toLowerCase();
    if (res.code !== 0 && /rate.?limit|quota|usage limit/.test(combined)) {
      log("fixer.rate_limited", { repo: repo.name, issue: issue.number });
      await swapLabel(repo.path, issue.number, AIRPLANE_LABEL, FIXING_LABEL);
      return;
    }

    if (res.timedOut) {
      await fail(repo, issue.number, `Timed out after ${Math.round(cfg.fixerTimeoutMs! / 60000)} minutes.\n\n<details><summary>Tail</summary>\n\n\`\`\`\n${tail(res.stdout + res.stderr)}\n\`\`\`\n</details>`);
      return;
    }

    // Verify new commits
    const hasCommits = await hasNewCommits(wt, repo.defaultBranch);
    if (!hasCommits) {
      await fail(repo, issue.number, `The fixer agent did not produce any commits.\n\n<details><summary>Tail</summary>\n\n\`\`\`\n${tail(res.stdout + res.stderr)}\n\`\`\`\n</details>`);
      return;
    }

    // Verify PR exists
    const prs = await listPRsForBranch(repo.path, branch);
    const pr = prs.find((p) => p.state === "OPEN");
    if (!pr) {
      await fail(repo, issue.number, `The fixer made commits but did not open a PR for branch \`${branch}\`.\n\n<details><summary>Tail</summary>\n\n\`\`\`\n${tail(res.stdout + res.stderr)}\n\`\`\`\n</details>`);
      return;
    }

    // Hand off to reviewer
    try {
      await addLabel(repo.path, pr.number, REVIEW_LABEL);
    } catch {
      // Labeling a PR is separate endpoint; `issue edit` also works on PRs on GitHub
    }
    await swapLabel(repo.path, issue.number, REVIEW_LABEL, FIXING_LABEL);
    log("fixer.handoff", { repo: repo.name, issue: issue.number, pr: pr.number });
  } catch (e: any) {
    log("fixer.error", { repo: repo.name, issue: issue.number, error: String(e?.message ?? e) });
    await fail(repo, issue.number, `Airplane fixer failed: \`${String(e?.message ?? e)}\``);
  }
}

function tail(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return "…" + s.slice(-max);
}

async function fail(repo: RepoConfig, num: number, body: string) {
  try {
    await commentIssue(repo.path, num, `<!-- airplane -->\nAirplane fixer failed.\n\n${body}`);
  } catch {}
  try {
    await swapLabel(repo.path, num, FAILED_LABEL, FIXING_LABEL);
  } catch {
    try {
      await removeLabel(repo.path, num, FIXING_LABEL);
      await addLabel(repo.path, num, FAILED_LABEL);
    } catch {}
  }
}

export async function fixerTick(): Promise<void> {
  if (running) return;
  if (isGloballyPaused()) return;
  const cfg = getConfig();
  if (!cfg.repos.length) return;

  running = true;
  try {
    // Ensure labels exist on each repo (idempotent; runs once per tick, cheap)
    for (const r of cfg.repos) {
      if (!r.paused) {
        try {
          await ensureLabels(r.path);
        } catch {}
      }
    }

    await resetStaleFixing(cfg.repos, cfg.staleFixingMs!);

    const next = await pickNextIssue(cfg.repos);
    if (!next) return;
    await runFixerOnce(next.repo, next.issue);
  } finally {
    running = false;
  }
}

export async function fixerManual(repoName: string, num: number): Promise<{ ok: boolean; error?: string }> {
  const cfg = getConfig();
  const repo = cfg.repos.find((r) => r.name === repoName);
  if (!repo) return { ok: false, error: `unknown repo ${repoName}` };
  if (running) return { ok: false, error: "fixer already running" };
  running = true;
  try {
    const issue = await getIssue(repo.path, num);
    await runFixerOnce(repo, issue);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    running = false;
  }
}
