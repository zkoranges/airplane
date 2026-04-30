# Decisions

Choices I made where the design doc was silent or open-ended. Every one picks the leanest path consistent with the document's stated principles.

## Runtime

- **Bun** (not Node + tsx). The doc mentions both as acceptable; Bun is simpler — one binary, no tsconfig gymnastics, native TS.
- **Hono** for HTTP (explicitly named in the doc). Used Hono's `streamSSE` helper for the chat and log streams.
- **chokidar** for config hot-reload — one dependency, handles macOS fsevents quirks.

## State & paths

- `airplane.log` lives in the project root (alongside the process). No rotation, per the doc.
- Worktrees live under `./.airplane/worktrees/<repo-name>/<issue-number>`. This is a single, predictable tree, cleanly pruned on startup and on merge.
- PID lockfile at `./.airplane/airplane.pid`.
- `airplane.config.ts` is `.gitignore`d because it contains local absolute paths. `airplane.config.example.ts` is committed.

## Scheduling

- One `setInterval` on `fixerIntervalMs` (default 5 min). Each tick runs fixer → reviewer → cleanup sequentially, guarded by a single `ticking` boolean so no overlap. This satisfies the doc's "reviewer runs on the same timer tick (after the fixer step) or on its own timer" and "serial only".
- An initial tick fires 5 s after startup so the user doesn't wait 5 minutes for the first pass.

## Labels on PRs

- The doc describes labels living on issues, but the reviewer needs to find PRs. I reuse the same label set on PRs — GitHub accepts labels on PRs via `gh issue edit` too, and `gh pr list --label airplane:review` works cleanly. One label scheme, applied wherever it makes sense.
- The fixer adds `airplane:review` to *both* the PR and the issue, so the reviewer can find PRs by label and the UI sees the issue status.

## Filtering Airplane comments from fixer context

- Comments authored by any user containing "airplane" in their login **or** comments containing the sentinel `<!-- airplane -->` **or** comments whose body starts with `Airplane fixer failed` / `Airplane reviewer` are filtered out. All failure comments Airplane posts include the `<!-- airplane -->` marker, so the filter is reliable.

## Reviewer decision parsing

- The reviewer prompt asks Claude to end with either `APPROVE: <reason>` or `REQUEST_CHANGES: <reason>`. The parser scans the tail of output for the first match. If neither line is found, it's treated as a reviewer failure (post a PR comment, fail the issue, clear the label).

## Rate limit handling

- Fixer detects "rate limit", "quota", or "usage limit" substrings in Claude's output when exit is non-zero. On hit, the issue is re-labeled from `airplane:fixing` back to `airplane` (not failed). Matches the doc's "back off until next tick" behavior with zero retries in the same tick.

## `gh pr merge --auto`

- Some repos don't have branch protection or required checks, in which case `--auto` rejects. The reviewer falls back to a direct `--squash` merge in that case. This is still a single approved merge, not auto-iteration.

## Cleanup idempotence

- A small in-memory `seenMerged` set avoids re-processing the same merged PR every tick. Safe to lose on restart — cleanup is idempotent (worktree removal + branch delete are both "if exists").

## Owner/repo lookup for issue URLs

- The UI shows clickable GitHub links. I fetch `nameWithOwner` from `gh repo view` lazily and cache it per repo path. Not worth a config field.

## /chat: GET in addition to POST

The doc says `POST /chat` (SSE). Browser `EventSource` is GET-only, and using `EventSource` keeps the UI to a few lines. So `/chat` accepts **both** GET (UI / EventSource) and POST (matches the doc, takes a JSON or form body). They share one handler.

## Chat is stateless

- Matches the doc exactly: each `/chat` call spawns a fresh `claude -p`. If the user wants continuity within a repo, they rely on Claude Code's own `--continue` in a local terminal. Airplane does not maintain a message history or session store.

## Chat meta-commands

- I do NOT parse meta-commands in Airplane. The doc says Claude parses them by calling back into the HTTP endpoints. The chat prompt tells Claude which endpoints exist and how to `curl` them. This is the only way to hold the line on "no command parser".

## Fork for fork-mode workflows

- Unsupported. The doc assumes direct-write access to each target repo. If you need forks, that's a future evolution.

## UI-managed repos (deviation from the design doc)

The doc says "Adding a new repo is editing the config file and saving. There is no UI for managing repos — intentionally." I built the UI add/remove flow anyway, **per an explicit user instruction that overrode the doc**. User instructions outrank the spec.

Implementation choices to keep this lean and consistent with the rest of the system:

- Two co-equal sources of repos: `airplane.config.ts` (static, committed) and `.airplane/repos.json` (dynamic, written by the server). At runtime they're merged and each repo carries a `source: "config" | "dynamic"` tag.
- The UI never edits `airplane.config.ts`. Repos added via UI live in their own JSON file. Removing a config-sourced repo from the UI is rejected — you have to edit the file (this matches "config is code" in spirit).
- Auto-derivation: from the path alone, the server figures out name (folder basename → slug), default branch (`git symbolic-ref refs/remotes/origin/HEAD`), and GitHub owner/repo (`gh repo view`). The user only types one absolute path.
- Validation is server-side: must be absolute, must exist, must be a directory, must be a git repo. Name collisions auto-suffix with `-2`, `-3` etc.
- A UI-added repo whose folder has gone missing on startup is auto-pruned with a log line, rather than failing the whole process. Static repos still hard-fail on missing folders (bad config = the user's mistake).
- `.airplane/repos.json` is git-ignored (state, not code).

## What I explicitly did NOT build

Per the "Deliberately Does Not Do" section:

- No DB, no auth, no retry/backoff, no prompt library, no plugin system.
- No parallel fixing.
- No fixer/reviewer iteration loop.
- No non-GitHub support.
- No message history.
- No metrics or tracing. One log file only.

And per "Future Evolutions":

- No weekly summary, no staleness label sweeper, no per-repo CLAUDE.md convention (though the reviewer *reads* CLAUDE.md/AGENTS.md/README.md if present — that's free context, not a new feature).
