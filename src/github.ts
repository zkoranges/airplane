import { run } from "./run";

export const AIRPLANE_LABEL = "airplane";
export const FIXING_LABEL = "airplane:fixing";
export const REVIEW_LABEL = "airplane:review";
export const BLOCKED_LABEL = "airplane:blocked";
export const FAILED_LABEL = "airplane:failed";

export const AIRPLANE_COAUTHOR = "Co-Authored-By: Airplane <airplane@local>";

export type Issue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  author: string;
  updatedAt: string;
};

export type PR = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  mergedAt?: string;
  merged?: boolean;
  labels: string[];
  body?: string;
  url?: string;
};

export type Comment = {
  author: string;
  body: string;
  createdAt: string;
};

async function gh(args: string[], cwd?: string) {
  return run("gh", args, { cwd });
}

export async function ghCheckAuth(): Promise<{ ok: boolean; message: string }> {
  const r = await gh(["auth", "status"]);
  return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() };
}

export async function ensureLabels(cwd: string) {
  // idempotent — ignore failures if label already exists
  const defs: [string, string, string][] = [
    [AIRPLANE_LABEL, "0E8A16", "queued for Airplane fixer"],
    [FIXING_LABEL, "FBCA04", "Airplane fixer is working on it"],
    [REVIEW_LABEL, "1D76DB", "Awaiting Airplane reviewer"],
    [BLOCKED_LABEL, "B60205", "Airplane blocked — human input needed"],
    [FAILED_LABEL, "D93F0B", "Airplane attempt failed"],
  ];
  for (const [name, color, desc] of defs) {
    await gh(
      ["label", "create", name, "--color", color, "--description", desc, "--force"],
      cwd
    );
  }
}

export async function listIssuesByLabel(cwd: string, label: string): Promise<Issue[]> {
  const r = await gh(
    [
      "issue",
      "list",
      "--label",
      label,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,body,labels,state,author,updatedAt",
    ],
    cwd
  );
  if (r.code !== 0) throw new Error(`gh issue list failed: ${r.stderr}`);
  const raw = JSON.parse(r.stdout || "[]");
  return raw.map((i: any) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    labels: (i.labels ?? []).map((l: any) => l.name),
    state: i.state,
    author: i.author?.login ?? "",
    updatedAt: i.updatedAt,
  }));
}

export async function getIssue(cwd: string, num: number): Promise<Issue> {
  const r = await gh(
    [
      "issue",
      "view",
      String(num),
      "--json",
      "number,title,body,labels,state,author,updatedAt",
    ],
    cwd
  );
  if (r.code !== 0) throw new Error(`gh issue view failed: ${r.stderr}`);
  const i = JSON.parse(r.stdout);
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    labels: (i.labels ?? []).map((l: any) => l.name),
    state: i.state,
    author: i.author?.login ?? "",
    updatedAt: i.updatedAt,
  };
}

export async function getIssueComments(cwd: string, num: number): Promise<Comment[]> {
  const r = await gh(
    ["issue", "view", String(num), "--json", "comments"],
    cwd
  );
  if (r.code !== 0) return [];
  const parsed = JSON.parse(r.stdout);
  const comments = parsed.comments ?? [];
  return comments.map((c: any) => ({
    author: c.author?.login ?? "",
    body: c.body ?? "",
    createdAt: c.createdAt,
  }));
}

export async function swapLabel(cwd: string, num: number, add: string, remove: string) {
  const r = await gh(
    ["issue", "edit", String(num), "--add-label", add, "--remove-label", remove],
    cwd
  );
  if (r.code !== 0) throw new Error(`swapLabel failed: ${r.stderr}`);
}

export async function addLabel(cwd: string, num: number, label: string) {
  await gh(["issue", "edit", String(num), "--add-label", label], cwd);
}

export async function removeLabel(cwd: string, num: number, label: string) {
  await gh(["issue", "edit", String(num), "--remove-label", label], cwd);
}

export async function commentIssue(cwd: string, num: number, body: string) {
  await gh(["issue", "comment", String(num), "--body", body], cwd);
}

export async function commentPR(cwd: string, num: number, body: string) {
  await gh(["pr", "comment", String(num), "--body", body], cwd);
}

export async function listPRsByLabel(cwd: string, label: string): Promise<PR[]> {
  const r = await gh(
    [
      "pr",
      "list",
      "--label",
      label,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,headRefName,baseRefName,state,labels,url",
    ],
    cwd
  );
  if (r.code !== 0) throw new Error(`gh pr list failed: ${r.stderr}`);
  const raw = JSON.parse(r.stdout || "[]");
  return raw.map((p: any) => ({
    number: p.number,
    title: p.title,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    state: p.state,
    labels: (p.labels ?? []).map((l: any) => l.name),
    url: p.url,
  }));
}

export async function listPRsForBranch(cwd: string, branch: string): Promise<PR[]> {
  const r = await gh(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      "number,title,headRefName,baseRefName,state,labels,url",
    ],
    cwd
  );
  if (r.code !== 0) return [];
  const raw = JSON.parse(r.stdout || "[]");
  return raw.map((p: any) => ({
    number: p.number,
    title: p.title,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    state: p.state,
    labels: (p.labels ?? []).map((l: any) => l.name),
    url: p.url,
  }));
}

export async function getPRDiff(cwd: string, num: number): Promise<string> {
  const r = await gh(["pr", "diff", String(num)], cwd);
  return r.stdout;
}

export async function reviewPR(
  cwd: string,
  num: number,
  decision: "approve" | "request-changes" | "comment",
  body: string
) {
  const flag =
    decision === "approve" ? "--approve" : decision === "request-changes" ? "--request-changes" : "--comment";
  const r = await gh(["pr", "review", String(num), flag, "--body", body], cwd);
  if (r.code !== 0) throw new Error(`gh pr review failed: ${r.stderr}`);
}

export async function enableAutoMerge(cwd: string, num: number) {
  const r = await gh(["pr", "merge", String(num), "--auto", "--squash"], cwd);
  if (r.code !== 0) {
    // Fallback: try direct squash merge if auto-merge not available (e.g., branch protection disabled)
    const r2 = await gh(["pr", "merge", String(num), "--squash"], cwd);
    if (r2.code !== 0) throw new Error(`gh pr merge failed: ${r.stderr}\n${r2.stderr}`);
  }
}

export async function closePR(cwd: string, num: number) {
  await gh(["pr", "close", String(num)], cwd);
}

export async function listMergedAirplanePRs(cwd: string, limit = 50): Promise<PR[]> {
  // Use search for merged PRs with the airplane branch prefix
  const r = await gh(
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      String(limit),
      "--json",
      "number,title,headRefName,baseRefName,state,mergedAt,labels,url",
    ],
    cwd
  );
  if (r.code !== 0) return [];
  const raw = JSON.parse(r.stdout || "[]");
  return raw
    .filter((p: any) => (p.headRefName as string)?.startsWith("airplane/issue-"))
    .map((p: any) => ({
      number: p.number,
      title: p.title,
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      state: p.state,
      mergedAt: p.mergedAt,
      merged: true,
      labels: (p.labels ?? []).map((l: any) => l.name),
      url: p.url,
    }));
}

export async function getPRBody(cwd: string, num: number): Promise<string> {
  const r = await gh(["pr", "view", String(num), "--json", "body"], cwd);
  if (r.code !== 0) return "";
  return JSON.parse(r.stdout).body ?? "";
}

export function extractIssueNumbersFromText(s: string): number[] {
  const nums = new Set<number>();
  const re = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(s))) nums.add(parseInt(m[1]!, 10));
  return [...nums];
}

export async function closeIssue(cwd: string, num: number) {
  await gh(["issue", "close", String(num)], cwd);
}

export async function getPRForIssueBranch(cwd: string, branchPrefix: string): Promise<PR | undefined> {
  const r = await gh(
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "20",
      "--json",
      "number,title,headRefName,baseRefName,state,labels,url",
    ],
    cwd
  );
  if (r.code !== 0) return undefined;
  const raw = JSON.parse(r.stdout || "[]");
  const hit = raw.find((p: any) => (p.headRefName as string)?.startsWith(branchPrefix));
  if (!hit) return undefined;
  return {
    number: hit.number,
    title: hit.title,
    headRefName: hit.headRefName,
    baseRefName: hit.baseRefName,
    state: hit.state,
    labels: (hit.labels ?? []).map((l: any) => l.name),
    url: hit.url,
  };
}
