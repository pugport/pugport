# Development workflows in PugPort

These are general PugPort capabilities, not a workflow hardcoded for one repository. Ordinary conversations keep their simple defaults; enable collaboration in that conversation when it needs subagents. Project conversations can collaborate by default. The existing permission, budget, routing, concurrency and cancellation rules still apply.

## Start a project workflow

1. Open a conversation associated with the repository. In the conversation toolbar, open **Collaboration**.
2. Choose how child tasks deliver changes. **Return files to the main task** retains the existing dirty-snapshot and checked-delivery behavior. **Independent branch** starts from a committed Git revision and keeps changes on that branch, without applying them to the parent directory.
3. Ask the main agent to delegate appropriate work, or create a named long-lived work line in the panel. Send a main task first: a work line records that task as its coordination source.
4. Open work lines from the indented sidebar. They are real conversations: subsequent messages reuse their checkout. Existing conversation archive/delete operations apply to the selected line, not the parent.
5. Review the result and evidence. A child's completion report, a local commit, a pushed branch and a merged PR are different states. PugPort does not turn a completion message into an acceptance or merge.

The agent-facing tools are `create_lane`, `list_project_conversations`, `send_conversation_message`, `list_conversation_work`, `schedule_work`, `watch_pull_request`, `pause_scheduled_work` and `delete_scheduled_work`. Native CLI-internal subagents remain separate unless the adapter supplies events for them.

## Plans, questions and project rules

The main task can use `set_plan` to maintain a visible plan list in an ordinary conversation as well as a swarm. Child tasks cannot replace the main task's plan. When `create_lane` includes `plan_id`, the work line is linked to that plan item; a missing item is added to the owner's list. The plan reflects the work line's running and completed states, including a saved completion whose root task is no longer in the loaded workflow list.

`ask_user` saves an inline **Question card** and returns immediately, so the agent can continue independent work. The card offers two answer buttons. Clicking one sends that option as a user message; the user can also type a reply or choose **Continue**. A later user message or user-initiated continuation marks the question answered and removes the card. Scheduled dispatches and automatic continuations do not answer it. If the composer already has a draft, send or clear it before using an answer button.

`ask_user` and `add_project_rule` are available only to a foreground main task, not a child task, background wakeup, external-origin task or conversation containing untrusted content.

`add_project_rule` requires a rule of at most 300 characters and a verbatim, contiguous quote of 8–300 characters from a message the user personally sent in this conversation. Delegated task text and third-party replies do not count. The project can hold at most 20 rules; an exact duplicate is reported without saving or broadcasting again. A new rule is saved through the project settings and broadcast, with its supporting quote, to other active runs in the same project. Runs that cannot receive it immediately receive a queued notice through the normal tool path. The sender is excluded, and the notice grants no new permission. To undo the rule, remove it in project settings. Read-only tasks may still add rules on purpose: a rule is a note of the user's own words, not a file write.

## Review before implementation

The coordinator prompt asks it to send an implementation brief to a read-only review child before delegating code changes. That reviewer uses the **Code review** role and `tier=strong`, with no pinned agent, model or effort, and checks the brief against the actual code. The coordinator revises the brief before assigning implementation. This is agent guidance, not an enforced execution gate.

Review verdicts can include optional findings shown under **Review notes**. Findings are grouped as **Must fix** (`must`), **Should fix** (`should`) and **Nit** (`nit`). Automatic revision requests include must and should findings with the requested fix; nits remain visible without being sent as revision instructions. Verdicts without findings retain the existing review behavior.

## Worktrees and commits

Independent branches use `git worktree add` from a committed revision. They do not copy the source's staged, unstaged, ignored or untracked changes. The old snapshot size/file limits do not apply to this mode. Repository hooks and checkout filters are not automatically executed. See [Branch workspaces](branch-workspaces.md) for the exact safety and symlink behavior.

The `commit_branch` host tool lets an authorized, active write task commit its own branch even when the native CLI cannot write shared Git metadata. It checks the current run, physical directory lease, branch ownership, actual changed paths and inherited file scope. It uses the user's existing Git identity and does not enable hooks, signing or filters. It never automatically pushes or merges. Configure an identity in the human terminal if Git does not have one.

Windows repositories using `core.symlinks=false` retain Git symlink entries as placeholder files, including when committed through the host. Those files are not operating-system links: builds requiring live links still need appropriate Windows link support. This setting is respected rather than silently changing repository configuration.

Native CLI network and command restrictions remain in effect. A host commit does not silently disable them or grant arbitrary `git push`, `gh` or SSH access.

`push_branch`, `open_branch_pull_request` and `merge_branch_pull_request` are the host tools for this worktree. Each one shows one owner card, and accepting the card is the owner doing that push, pull request or merge. PugPort never force-pushes. A push sends only `sha:refs/heads/branch`, with tags and submodules left behind, and host pushes run with hooks off. `gh` runs in an empty temporary directory, not in the worktree. The git remote URL is never shown; the card says `owner/repo`.

Before a card appears, PugPort checks PR titles and bodies, comments and first-time pushed commit messages for local user paths, emails, secret-looking strings, record-file names and chat quotes. It also checks pushed paths for record-file names. A hit stops the write. Posted text is read back when supported: a mismatch reports the URL without reposting, and an unavailable read-back is a warning in the result. If a project sets a required identity, `push_branch` checks the authors of commits the remote does not yet have; there is no default identity and none is inferred from the repository.

Paths under migrations, CODEOWNERS and workflows, and pushes to main, master, develop, release branches or the remote default branch always receive a card. A project no-merge window refuses merges. The `github_*` connector writes use the same text, path and branch checks and supported read-back, while retaining their fixed approval table. Gate settings are per computer and have no settings page yet. An executor that already has network access can still run `git push` itself.

## Permission ceiling

Each run computes its permission ceiling after planning and reply merging settle its final input, and reports it once: `Permission ceiling: write … · network … · Git commits …`.

- **Network.** Only writable runs without untrusted content, a command ban, text-only mode or a background wakeup can enable it. User/text/device origins allow it. A caller-origin task uses the caller probe's network report; Codex workspace-write needs top-level `[sandbox_workspace_write].network_access` or a command-line `-c` override (profile tables are ignored). Role, untrusted, privacy, external and parent origins deny it. A parent origin denotes a narrowed grant; a previous native session is not the dispatcher and its run record cannot grant network access.
- **Probe limit.** Claude Code with its own sandbox enabled is still reported as network-capable when its write mode allows writes. The current probe does not detect that executor's separate network restrictions.
- **Local Git commits.** Codex write runs in a linked worktree get the worktree's own Git directory plus shared `objects`, `refs` and optional `logs`. The real Git directory must be directly under the common repository's `worktrees` directory and its registration must point back to this checkout's `.git`; forged or redirected registrations grant nothing. Storage paths are realpath-resolved, so a junction on the way to real Git storage is followed and the real location is granted. Required directories are checked at that location; missing or linked required directories grant nothing, and absent or linked `logs` is omitted. The common directory itself, `config`, `hooks`, `info` and `packed-refs` are never granted.
- **Managed directories.** Branch lanes use their host record's validated paths. Snapshot children receive no Git write paths, including when their workflow record is absent or mismatched. Other checkouts or Git paths inside the real application data directory receive none. Main checkouts receive none because their index shares a directory with configuration and hooks; use a work lane or let the dispatcher commit.
- **Executors.** Only non-trusted Codex is enforced by PugPort's sandbox. Trusted-project and device full access show "full access". In a trusted project a writable task from a local caller (Claude Code, Codex or another CLI through the pugport MCP, or `pugport ask --write`) gets the same full access as one typed in the app; a turn whose context carries web search results, or one with untrusted content, does not. PugPort's own executors cannot get it this way: their writable external requests are refused before a task exists (executor marker and process-ancestry check). When the check cannot identify the caller, the writable request is refused with a retryable error (HTTP 503 with `Retry-After`) instead of being let through. A process that an executor starts outside its own process tree is identified as an ordinary local caller, so it could still dispatch with full access in a trusted project. Other executors show Git on when the run may write and retain the "not enforced" suffix, including in a main checkout. Git paths are probed only for Codex or Windows learn mode; learn mode records access without blocking and its network egress is unchanged. Pi is never probed. Pi automatic mode shows network and Git off and explains that it runs no commands. Pi ask mode allows user-approved commands and uses the ordinary unenforced line.

Network and Git paths are recomputed for each run, never copied on continue or relay. No task request can set them; the caller probe reports network capability like the write mode. Whether the four folders permit commits while denying config/hooks through the app-server per-turn `writableRoots` with the Windows sandbox setting is not yet verified; the historical check used `codex exec --add-dir`.

## Messages, wakeups and background work

The collaboration panel lists other live conversations in the same project. Messages retain their sender and task provenance; they do not become user instructions or approval. A message can wake an idle recipient for a read-only response. A work line's settled foreground task reports to its coordinator once. Background responses cannot form recursive wakeup chains or create new background work on their own.

Work lane results keep their visible collaboration mail. When a coordinator has an active root-task run, PugPort also sends the result into that run with the same other-agent provenance notice. Only a successful steer marks the mail delivered; queued notices and unavailable steering leave it pending for the normal read-only wake. A queued notice taken by a tool call counts as delivered and prevents a duplicate wake. These notifications are data from another agent, do not become user follow-ups on account switch or continuation, are replayed in a separate other-agent data section, and cannot change network permissions.

Results longer than 1500 characters are saved under `<dataDir>/member-results/<conversationId>/<workflowId>.md`. The coordinator receives a summary and a path to read with `read_document`. If saving fails, work lane mail retains the first 10000 characters. Third-party web replies remain guarded: tool-capable coordinators receive neither their raw text nor a file path. External `task_result` keeps its full `result` text and adds `resultPath` when a long result is saved; a non-completed task with a separate error does not save a result file. MCP output appends `Full result: <path>` when a path is available.

A lane started by its coordinator sends `ask_user` questions to that coordinator. A turn the owner starts by typing in the lane asks the owner there instead. The coordinator can call `answer_lane_question` with the supplied `lane_id`, `question_id` and an option or its own answer (for example, "Use synthetic fixture Alpha"). Each question accepts one coordinator answer. The answer starts a background turn in the lane: it cannot publish, create lanes, schedule work or ask another question. It can write only if both the asking lane turn and the answering coordinator turn can write. The owner can always answer directly in the lane. An open relayed question keeps its plan item unfinished.

`list_conversation_work` also returns child `lanes` with their title, branch, state, last saved result path and update time. Its states use the sidebar rules: `running`, `waiting-user`, `queued` and `idle`. Background wakeups still cannot create work lanes or background jobs.

A lane row also carries `github` once the lane is bound: `repository`, `issue`, `pull.number`/`pull.url`, and from the PR monitor the derived `state`, `headSha`, `checks` (passed, failed, pending) and `observedAt` (when the state last changed). `create_lane.issue` records the issue; without it, a branch named `<who>/<issue>-<slug>` supplies it (`release/2026-10` does not). Opening or merging a PR with the host tools from a lane binds that lane automatically; a coordinator's own chat binds nothing. If the PR was created but its read-back failed, the tool reports an error and the lane stays unbound until the coordinator calls `watch_pull_request` with `lane_id`, which binds one of its own lanes to the watched PR.

One-time and interval jobs are saved locally. A PR monitor reads the pull request with one `gh pr view --json` call per poll, without invoking a model, and writes the derived state to every lane bound to that PR. The states, first match wins, are `merged`, `closed`, `draft`, `changes-requested`, `checks-failing`, `checks-running`, `approved`, `review-requested`, `checks-passing` and `open`. The first read records a baseline. Later, a read-only response is enqueued through normal routing only when the state changes into `checks-failing`, `checks-passing`, `changes-requested`, `approved` or `review-requested` and that head's checks have all run; a failure wakes at once, and more failures on the same head stay silent. A new commit stays silent until its checks settle, draft toggles are silent, and a PR without checks never wakes. Polling continues while a wake is pending; a newer observation replaces the pending one. The wake carries the state, short head, check counts, failed check names and the PR link, never comment text. After the pull request is merged or closed, the monitor turns itself off without a wake. When `gh` fails (for example signed out), the monitor retries at its own interval. Pause or delete a monitor when no longer needed. This requires an available, authenticated `gh` with access to the chosen repository. It does not comment, rerun checks, push or merge.

Repositories with live lanes or enabled PR monitors also share a persistent GitHub watch. New lanes read their checkout's local `origin` without network access, so a lane can receive repository news before it has a PR. Comments by non-bot writers can freeze a repository (issue conversation) or hold a PR (PR conversation); use `unfreeze` / `freeze lifted` or `unhold` / `hold lifted` to release it. Leave these comments in the conversation, not a review or inline diff. Each poll checks active hold comments first; deletion or loss of write access releases the hold. Editing away the signal also releases it, and closing or merging a PR clears its hold. Permission API answers are cached for 24 hours, so revocation can take up to 24 hours to be noticed. A 404 permits only the OWNER association as an uncached fallback, while transient errors leave the comment for retry. Hold and lift commands must start a line; casual phrases such as "hold on" are ignored, and a hold takes precedence when both signals appear. `revert` only reports a request. PugPort refuses its own merge tool while a known hold applies, checks again after confirmation, and adds a warning when comments cannot be fully checked. Holds never expire automatically. The first look covers seven days without waking a model, but applies holds immediately. GitHub Actions push runs report red/green transitions on the default branch, `develop` and `release/*`; external CI statuses are not covered. Polls share four `gh` calls per tick with PR monitors, prioritize older due work, run every five minutes (fifteen after twelve quiet cycles), and back off to sixty minutes on failure. Failures never wake a model; after 24 hours they appear in `list_conversation_work.repositories`, alongside holds, branch states and the last comment check. Notices contain fixed event labels, sanitized authors, branches and workflow names, and validated GitHub links, never comment bodies. Pending notices are delivered before polling. Each conversation receives one combined read-only notification through active-run steering or an idle scheduled wake. New events replace undelivered events for the same key, an undelivered red/green pair cancels, and notices expire after 24 hours.

PugPort must be running for these jobs to execute. They do not wake a powered-off computer. On restart, persistent due work is considered by the normal queue; exact client request IDs prevent replay of already accepted sends. Revocation, archived/deleted conversations, removed projects and shutdown are rechecked before dispatch. Paused jobs cannot be resumed as write tasks by a read-only agent.

## Models and routing

Use a named routing profile on a conversation, or `dispatch_task.routing_profile_id` for an external task. `list_routing_profiles` lists the available profiles. The profile is captured on the new task; it does not change another project's defaults.

Rule sets can preserve ordered candidates or explicitly select by quota across candidates. Model exclusions apply to automatic candidates and fallback paths. A user's explicit manual model selection retains its established precedence. Only installed, connected and eligible executors participate; the service does not invent connections or bypass reserve/budget limits.

## Project memory, MCP and remote commands

Under **Project context and fixed remote queries**, the user can explicitly select an existing Claude memory directory. PugPort validates and records the directory identity and passes only `autoMemoryDirectory` to the Claude adapter. It does not import executable hooks, environment settings or arbitrary contents from `settings.local.json`. This path grant is project-specific; ordinary and incognito chats do not inherit it.

The existing account-shared configuration handles Claude project memory across local account cards. MCP servers can be explicitly imported through **Extensions → Add → Import from another AI application**. Preview and select the entries before installing. Central bridge tools can then be used by the eligible CLI and API executors under their normal permissions. Default user-level Claude/Codex configurations are supported; project-level files, WSL/custom account homes and OAuth state may require explicit setup. Credentials and private policies must never be copied into application source or defaults.

For a known remote diagnostic, the user defines a name, SSH host and fixed executable/argument array. The agent can list names/hosts and run an ordinary query by name without changing its arguments. Remote jobs below extend these definitions with declared parameters. These are **user-authorized fixed remote queries**, not a claim that arbitrary remote commands can be proven read-only. SSH must already authenticate non-interactively with strict host verification. Output is bounded and redacted. Cancelling the local SSH connection does not prove a remote process has stopped.

## Remote jobs

Define jobs in the project's fixed remote-query editor, under **Job options**. Definitions stay in the project's SQLite configuration and can only be changed through the authenticated user settings. Agents run a saved name with exactly the declared parameters; they cannot supply another executable. Supported parameter types are `sha`, `branch`, `relpath`, `word` and `int`. An argv placeholder must occupy a whole argument and cannot replace the executable.

All three job tools are listed for read-only and writable callers. Starting a job requires write access unless its definition has `readOnly: true`, which is the owner's declaration, not an automatic check of the command. Status and cancellation reject job IDs from another project. `list_remote_queries` includes the `background`, `params`, `readOnly` and `push` fields; `run_remote_query` refuses definitions with `background` or `params`.

For example, save this synthetic definition using the editor's fields (parameters are entered one per line, such as `branch=branch`). The SSH alias, bare repository, working directory and script must already exist; the script is responsible for using the pushed revision:

```json
{
  "name": "demo-check",
  "host": "example-build-host",
  "argv": ["/srv/example-project/check.sh", "{branch}"],
  "params": { "branch": "branch" },
  "push": {
    "repository": "/srv/example-project.git",
    "refs": ["+{branch}:refs/heads/job-input"]
  },
  "cwd": "/srv/example-project",
  "background": true,
  "timeoutSeconds": 600
}
```

Call the tools with these arguments, replacing the sample job ID with the `jobId` returned by the start call. Use cancellation if you want to stop the job:

```text
run_remote_job({"name":"demo-check","params":{"branch":"main"},"wait_seconds":10})
remote_job_status({"job_id":"rj-20261027-0123abcd"})
cancel_remote_job({"job_id":"rj-20261027-0123abcd"})
```

Push runs from the current project's folder before the job starts, using an `ssh://` URL and the same hardened SSH options as queries. A push failure returns `push-failed` without starting the job. The remote host must provide `flock`, `setsid` and `timeout`; jobs write their runner and logs under `~/.pugport-jobs`. A remote lock allows one running job per server; a competing start returns `busy`.

There is no background polling. Each status lookup for a job that reached the remote start uses one SSH connection to read its exit code, up to 50 `RESULT:` lines (4,000 characters total) and the last 32 KiB of output, with secret redaction. Jobs that never reached remote start return their saved result without SSH. Records are saved in the workspace store as `remote-job`, with `projectId`, so the same job ID can be queried after PugPort restarts. A failed lookup keeps the previous result and adds `error`.

`wait_seconds` defaults to 0 and accepts integers from 0 to 300. Waiting sleeps in fixed 5-second steps between lookups and stops when the job is no longer running; at most three waits run at once. Background jobs allow timeouts up to 14,400 seconds; other queries retain the 120-second limit. A missing or empty exit file means running until a successful lookup occurs after `startedAt + timeoutSeconds + 60 seconds`; then the result is `timed-out` with `remoteMayContinue: true`. Exit codes 124 or 137 also mean `timed-out`. Cancellation sends TERM to the saved `timeout` PID (`tpid`) and reports `remoteMayContinue` until a later lookup confirms an exit.

## Formal judge

The [GitHub maintainer bot](maintainer-bot.md) uses a separate no-tools PR judge for every PR it judges, including collaborator PRs. It receives bounded PR text and cannot execute repository code. The tool-using formal judge described below refuses execution on macOS and on the node role; choosing either as the maintenance host does not enable that judge. Trusted full-suite runs remain on the desktop, and non-collaborator code never runs on maintainer computers or servers.

A formal judge run evaluates a local commit against a claim in a disposable detached checkout. The repository supplies the prompt, model and timeout in `.pugport/judge.md`; PugPort supplies the runner and returns the result to the calling project task. `run_judge` starts a run, `judge_result` reads it and can wait up to 300 seconds, and `cancel_judge` stops it. A dry run never posts a verdict.

PugPort reads `.pugport/judge.md` from the registered project folder, never from the commit being judged. In a shared repository, keep this file out of Git, for example by adding `.pugport/judge.md` to `.git/info/exclude`. If it is tracked, the result includes a warning: the registered folder itself can be checked out to a branch that changes the prompt.

This synthetic template illustrates all supported keys; replace the example model and account with ones available on this computer, or omit them:

```text
---
executor: codex
model: example-model
effort: high
account: Example account
network: false
timeout_minutes: 60
base: origin/main
---
Evaluate the claim for commit {{sha}} in {{repository}}.
Claim: {{claim}}
Base: {{base}}
Mode: {{mode}}
First line: <VERDICT> @ {{sha}}
Explain your evidence. Last line: JUDGE: synthetic judge
```

Front matter is optional and uses one `key: value` per line without inline comments. `executor` is `codex` or `claude` (default `codex`); `model`, `effort`, `account` and `base` are optional. `network` defaults to `false` and controls the requested Codex sandbox network setting; `timeout_minutes` defaults to 60 and accepts integers from 1 to 240. Without `account`, the first ready native account for the executor is selected. The template supports `{{sha}}`, `{{pr}}`, `{{repository}}`, `{{claim}}`, `{{base}}` and `{{mode}}`. In this local dry run, `repository` is the registered project path, `mode` is `dry`, and `pr` and an omitted `base` are empty. Unknown placeholders remain literal.

The first non-empty output line must start with `<VERDICT> @ <sha>`, using at least seven hexadecimal characters from the judged commit's SHA. The verdict word is case-sensitive: `PASS`, `CONFIRMED` and `APPROVED` mean pass; `FAIL`, `REFUTED` and `REJECTED` mean fail; `BLOCKED`, `UNVERIFIABLE` and `INCONCLUSIVE` mean blocked. Other words or a mismatched SHA produce `invalid`. The template asks for a final `JUDGE: …` line; the runner returns the last such line if present, but does not require or trust it.

For Codex, the runner passes `exec --ignore-user-config --ignore-rules --ephemeral -C <checkout> -s workspace-write -c sandbox_workspace_write.network_access=<network> --disable hooks --disable plugins`, followed on Windows by `-c windows.sandbox='<mxc|elevated>'` as selected by the sandbox probe. Optional model and effort use `-m <model>` and `-c model_reasoning_effort=<effort>`. It ends with `--color never --json -o <data dir>/judge/<id>/last.txt -`, with the rendered prompt on standard input.

For Claude, the runner passes `-p --output-format json --safe-mode --restricted --strict-mcp-config --no-session-persistence --disable-slash-commands --tools Read,Glob,Grep --permission-prompts none --settings <JSON>`; the JSON sets `autoMemoryDirectory` to the run's `memory` folder. Optional model and effort use `--model <model>` and `--effort <effort>`. The rendered prompt goes on standard input. The runner removes `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` from the inherited environment and does not sync account configuration before spawning.

These flags are a request, not proof of isolation. Provenance reports `isolation=flags-only`, and `user-docs=present|absent` reports whether the account's `AGENTS.md` or `CLAUDE.md` exists, not whether the CLI read it. Repository instructions remain in the checkout; provenance reports `repo-docs=on` for Codex and `off` for Claude. Managed settings can still apply. The requested sandbox policy has not been independently verified, and real CLI behavior, including the combination of Claude `--safe-mode` and `--restricted` and whether Codex reads its account's `AGENTS.md`, requires separate validation. Codex may run judged code in the requested local sandbox on this computer; do not treat the flags as proof that access outside the checkout is impossible.

Run files, including `prompt.md`, `verdict.md`, `last.txt`, `cli.log`, temporary files and the checkout, live under `<data dir>/judge/<id>/`. The checkout is removed after the run when possible; a cleanup failure is reported with its retained location. Only one judge runs per computer at a time, and a competing request returns `busy`. The dry-run runner does not publish a verdict; if network access is enabled, the CLI's effective network restrictions still need independent verification.

## Terminal, browser and old history

**Terminal / Web** opens the human-operated terminal, isolated embedded browser and explicit Chrome debugging connection. Switching to the collaboration panel preserves open desktop tools. The terminal's contents are not fed to a model or saved as a task transcript. Closing the terminal panel ends its owned terminal. See [Desktop tools](desktop-tools.md) for the connection, permission and platform details.

The Chrome connection requires a debugging endpoint the user has already enabled. It does not silently read a Chrome profile or login cookies. A reviewable Chrome MCP configuration can be generated, then imported and authorized through Extensions. Real websites, login state and model-browser interaction require validation in the user's environment.

**Import Claude history** reads an explicitly selected JSON export or Code JSONL file. It imports bounded text history with source/order/time provenance into a tool-less read-only conversation. It ignores tool execution and thinking records and does not continue native CLI tool state, replay approvals or adopt an existing native session. The source file is preserved.

## Verification boundaries

Tests use synthetic repositories, fake executor/model responses, synthetic CDP endpoints and hidden Electron windows. Windows checks include an actual local PTY and browser view. They do not contact paid models, change real repositories, execute real SSH diagnostics or mutate GitHub. macOS/Linux native execution and packaged distributions require their own validation. No single local test establishes a formal zero-context judge: review the actual adapter configuration and evidence for that separate requirement.

The design references [Orca](https://github.com/stablyai/orca) for worktree and desktop workflow organization, while retaining PugPort's existing scheduler, adapters and tools. Orca source is not copied into this implementation. Directly used terminal dependencies retain their license notices.
