# airplane

Personal, single-user automation layer. Turns phone messages into GitHub issues, then autonomously fixes them with Claude Code.

Not a platform. Not multi-tenant. Not for anyone else.

## What it does

Two loops over one substrate (GitHub):

- **Chat loop** — you text a repo-scoped message from your phone over Tailscale, Claude Code turns it into a rich GitHub issue labeled `airplane`.
- **Fixer loop** — every N minutes, it picks up one `airplane` issue, spawns Claude in a fresh git worktree, commits a fix, opens a PR, hands off to a reviewer.
- **Reviewer loop** — a **separate** Claude invocation (no shared context with the fixer) reviews the diff. Approve → auto-merge squash. Reject → close PR, label the issue `airplane:failed`. No auto-iteration.
- **Cleanup** — merged Airplane PRs get their worktrees and branches removed.

All state lives in GitHub labels. Airplane keeps no database.

## Requirements

- macOS or Linux
- [`bun`](https://bun.sh)
- [`gh` CLI](https://cli.github.com) authenticated (`gh auth login`)
- [`claude` CLI](https://github.com/anthropics/claude-code) with an active subscription
- `git`

## Install

```sh
bun install
cp airplane.config.example.ts airplane.config.ts
# edit airplane.config.ts to add your repos
bun run start
```

## Configure

Edit `airplane.config.ts`:

```ts
import type { AirplaneConfig } from "./src/config";

const config: AirplaneConfig = {
  port: 4242,
  fixerIntervalMs: 5 * 60 * 1000,
  fixerTimeoutMs: 15 * 60 * 1000,
  repos: [
    {
      name: "myrepo",              // slug used in paths, branches, and HTTP routes
      path: "/Users/you/code/myrepo",
      defaultBranch: "main",
      paused: false,
    },
  ],
};

export default config;
```

Config is hot-reloaded. Save the file, airplane picks up the change. A syntax error keeps the last-good config running and logs the failure.

The config file is in `.gitignore` because it contains local filesystem paths.

## Run

```sh
bun run start
```

Then open `http://<this-laptop>:4242` from your phone over Tailscale. No auth — Tailscale is the boundary.

## UI

- **chat** — repo picker + text input. SSE stream of Claude output.
- **issues** — all airplane-labeled issues across your repos, grouped by state.
- **log** — live tail of `airplane.log`.
- **controls** — global pause/resume, per-repo pause/resume, kill switch, manual fix trigger.

## Labels

Airplane creates these on startup if missing:

- `airplane` — queued
- `airplane:fixing` — claimed by fixer
- `airplane:review` — PR awaiting reviewer
- `airplane:blocked` — human input needed
- `airplane:failed` — see comments

## HTTP routes

All local-bind, all unauthenticated.

```
GET  /                     UI
GET  /repos                repos + pause state (JSON)
GET  /issues               all airplane-labeled issues (JSON)
GET  /chat?repo=&message=  SSE chat stream (used by browser EventSource)
POST /chat                 SSE chat stream, JSON body {repo, message}
POST /fix/:repo/:number    manual fix trigger
POST /pause | /resume      global pause
POST /pause/:repo          per-repo pause
POST /resume/:repo         per-repo resume
POST /kill                 stop timer + SIGKILL any running claude
GET  /log                  SSE log tail
```

## Recovery

- A PID lockfile at `.airplane/airplane.pid` prevents two instances.
- On startup: any issues stuck in `airplane:fixing` get reset to `airplane`. Orphan worktrees under `.airplane/worktrees/` are pruned.
- On the timer: `airplane:fixing` issues older than `staleFixingMs` (default 30 min) are reset.

## Conventions

- Branches: `airplane/issue-<n>-<slug>`
- Commits: trailer `Co-Authored-By: Airplane <airplane@local>`

## Safety

- Claude runs with `--dangerously-skip-permissions` in the fixer, reviewer, and chat. This is by design. Don't add repos you're not comfortable having edited without approval.
- Reviewer is a **separate** Claude invocation, not a continuation of the fixer.
- **No auto-iteration**: a rejected PR fails the issue. Human decides next.

## File layout

```
src/
  index.ts      entry point — lock, config, checks, recovery, server, timer
  config.ts     config loader + hot-reload
  server.ts     Hono HTTP + SSE
  chat.ts       chat prompt + stream
  fixer.ts      fixer loop
  reviewer.ts   reviewer loop
  cleanup.ts    merged-PR cleanup + orphan worktree prune
  github.ts     gh CLI wrapper
  claude.ts     claude CLI wrapper
  git.ts        git helpers (worktrees, branches)
  startup.ts    preflight checks + recovery
  lockfile.ts   PID lock
  log.ts        append-only log + SSE tail
  run.ts        child_process wrappers
  ui.html       single-page UI (vanilla JS, no build)
```

About 1.9k lines of TypeScript total. Reading the whole thing should take an afternoon.

## Design

The full design constraints (and what Airplane explicitly does NOT do) live in [DECISIONS.md](./DECISIONS.md). Highlights:

- No DB, no auth, no retries, no plugin system, no message history, no parallel fixing.
- Reviewer is a separate Claude invocation — not a continuation. No fixer↔reviewer iteration.
- Claude Code runs in `--dangerously-skip-permissions` mode. Tailscale + a single-user laptop is the security boundary.
- All job state lives in GitHub labels. Restarting the process loses nothing meaningful.
- Recovery is structural: stuck `:fixing` issues get reset; orphan worktrees get pruned; a stale lockfile gets replaced.

## License

MIT.
