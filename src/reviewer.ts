import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAILED_LABEL,
  FIXING_LABEL,
  REVIEW_LABEL,
  addLabel,
  closePR,
  commentIssue,
  commentPR,
  enableAutoMerge,
  extractIssueNumbersFromText,
  getIssue,
  getIssueComments,
  getPRBody,
  getPRDiff,
  listPRsByLabel,
  removeLabel,
  reviewPR,
  swapLabel,
} from "./github";
import type { RepoConfig } from "./config";
import { getConfig, isGloballyPaused } from "./config";
import { claudeOneShot } from "./claude";
import { log } from "./log";

let running = false;
let currentReviewerChild: { kill: () => void } | null = null;

export function killCurrentReviewer() {
  currentReviewerChild?.kill();
}

function repoContext(repoPath: string): string {
  for (const f of ["CLAUDE.md", "AGENTS.md", "README.md"]) {
    const p = join(repoPath, f);
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, "utf8");
        return `### ${f} from the repo\n${text.slice(0, 6000)}\n`;
      } catch {}
    }
  }
  return "";
}

function reviewerPrompt(diff: string, issueTitle: string, issueBody: string, repoCtx: string): string {
  return `You are Airplane's reviewer agent. Do not edit files. Do not run commands. Just read and decide.

You are reviewing a PR produced by another agent for the following GitHub issue.

Issue title: ${issueTitle}

Issue body:
${issueBody || "(empty)"}

${repoCtx}

Here is the diff of the PR:

\`\`\`diff
${diff.slice(0, 80_000)}
\`\`\`

Your job: decide APPROVE or REQUEST_CHANGES.

Approve only if:
- The diff addresses the issue.
- There are no obvious regressions, dangerous changes, or clearly wrong logic.
- The change is scoped to the problem (no stray refactors, no unrelated files).

Otherwise request changes.

Output EXACTLY ONE of the following as your final line, with no extra text on that line:
APPROVE: <one-sentence reason>
REQUEST_CHANGES: <one-sentence reason>

You may put a short explanation (a few bullet points) before the final line. Be concise.`;
}

function parseDecision(text: string): { decision: "approve" | "request"; reason: string } | null {
  const lines = text.trim().split(/\r?\n/).reverse();
  for (const raw of lines) {
    const l = raw.trim();
    const m = /^APPROVE\s*:\s*(.+)$/i.exec(l);
    if (m) return { decision: "approve", reason: m[1]!.trim() };
    const m2 = /^REQUEST_CHANGES\s*:\s*(.+)$/i.exec(l);
    if (m2) return { decision: "request", reason: m2[1]!.trim() };
  }
  return null;
}

export async function reviewerTick(): Promise<void> {
  if (running) return;
  if (isGloballyPaused()) return;
  const cfg = getConfig();
  running = true;
  try {
    for (const repo of cfg.repos) {
      if (repo.paused) continue;
      let prs;
      try {
        prs = await listPRsByLabel(repo.path, REVIEW_LABEL);
      } catch (e: any) {
        log("reviewer.list.error", { repo: repo.name, error: String(e?.message ?? e) });
        continue;
      }
      for (const pr of prs) {
        await reviewOne(repo, pr.number, pr.title);
      }
    }
  } finally {
    running = false;
  }
}

async function reviewOne(repo: RepoConfig, prNum: number, prTitle: string) {
  log("reviewer.start", { repo: repo.name, pr: prNum });
  try {
    const diff = await getPRDiff(repo.path, prNum);
    const body = await getPRBody(repo.path, prNum);
    const issueNums = extractIssueNumbersFromText(body);
    let issueTitle = prTitle;
    let issueBody = "";
    let issueNum: number | undefined = issueNums[0];
    if (issueNum) {
      try {
        const iss = await getIssue(repo.path, issueNum);
        issueTitle = iss.title;
        issueBody = iss.body;
      } catch {}
    }
    const ctx = repoContext(repo.path);
    const prompt = reviewerPrompt(diff, issueTitle, issueBody, ctx);

    const res = await claudeOneShot(repo.path, prompt, {
      timeoutMs: 10 * 60 * 1000,
      onSpawn: (kill) => {
        currentReviewerChild = { kill };
      },
    });
    currentReviewerChild = null;
    if (res.timedOut) {
      log("reviewer.timeout", { repo: repo.name, pr: prNum });
      // Remove label so we try again next tick
      try {
        await removeLabel(repo.path, prNum, REVIEW_LABEL);
        await addLabel(repo.path, prNum, REVIEW_LABEL);
      } catch {}
      return;
    }

    const decision = parseDecision(res.stdout);
    if (!decision) {
      log("reviewer.parse.failed", { repo: repo.name, pr: prNum });
      await commentPR(repo.path, prNum, `<!-- airplane -->\nAirplane reviewer could not produce a decision. Tail:\n\n\`\`\`\n${tail(res.stdout)}\n\`\`\``);
      await markIssueFailed(repo, issueNum, `Reviewer could not produce a decision on PR #${prNum}.`);
      await removeLabel(repo.path, prNum, REVIEW_LABEL);
      return;
    }

    if (decision.decision === "approve") {
      // Try a formal approval first; if GitHub blocks it (own PR / permissions),
      // fall back to a comment — the intent is "approve → merge", not the review object.
      try {
        await reviewPR(repo.path, prNum, "approve", `Airplane reviewer: ${decision.reason}`);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        log("reviewer.approve.soft_fail", { repo: repo.name, pr: prNum, error: msg });
        try {
          await commentPR(
            repo.path,
            prNum,
            `<!-- airplane -->\nAirplane reviewer: ✅ approve — ${decision.reason}\n\n(formal review blocked: \`${msg.trim().split("\n").pop()}\`)`
          );
        } catch {}
      }
      try {
        await enableAutoMerge(repo.path, prNum);
      } catch (e: any) {
        log("reviewer.automerge.error", { repo: repo.name, pr: prNum, error: String(e?.message ?? e) });
      }
      await removeLabel(repo.path, prNum, REVIEW_LABEL);
      log("reviewer.approved", { repo: repo.name, pr: prNum });
    } else {
      try {
        await reviewPR(repo.path, prNum, "request-changes", `Airplane reviewer: ${decision.reason}`);
      } catch (e: any) {
        // Same self-review restriction. A PR comment carries the same information.
        log("reviewer.request.soft_fail", { repo: repo.name, pr: prNum, error: String(e?.message ?? e) });
        try {
          await commentPR(
            repo.path,
            prNum,
            `<!-- airplane -->\nAirplane reviewer: ❌ request changes — ${decision.reason}`
          );
        } catch {}
      }
      // Close PR, fail issue, no auto-iteration.
      try {
        await closePR(repo.path, prNum);
      } catch {}
      await removeLabel(repo.path, prNum, REVIEW_LABEL);
      await markIssueFailed(repo, issueNum, `Reviewer requested changes: ${decision.reason}`);
      log("reviewer.rejected", { repo: repo.name, pr: prNum, reason: decision.reason });
    }
  } catch (e: any) {
    log("reviewer.error", { repo: repo.name, pr: prNum, error: String(e?.message ?? e) });
  }
}

async function markIssueFailed(repo: RepoConfig, num: number | undefined, reason: string) {
  if (!num) return;
  try {
    await commentIssue(repo.path, num, `<!-- airplane -->\nAirplane reviewer failed this attempt: ${reason}`);
  } catch {}
  for (const from of [REVIEW_LABEL, FIXING_LABEL, "airplane"]) {
    try {
      await swapLabel(repo.path, num, FAILED_LABEL, from);
      return;
    } catch {}
  }
  try {
    await addLabel(repo.path, num, FAILED_LABEL);
  } catch {}
}

function tail(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return "…" + s.slice(-max);
}
