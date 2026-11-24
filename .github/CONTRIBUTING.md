# Contributing to PugPort

Bug reports, ideas, documentation, and code contributions are welcome. Use any editor or development tools. No AI subscription, pstack, Ponytail, or other skill package is required. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Share an idea or problem

Open an issue with what you tried or wanted to do, what happened, and what would help. Short reports in English or Chinese are welcome. The forms are prompts; unknown versions, reproduction steps, or affected modules can be left out. Maintainers can help clarify scope and acceptance criteria. You do not need to install the development environment, claim the issue, or propose an implementation to give feedback. Open-ended questions and early ideas can also go to [GitHub Discussions](https://github.com/pugport/pugport/discussions).

Remove private information from reports. Security reports follow [SECURITY.md](SECURITY.md) instead of public issues. Code contributors can continue below and read the shared rules in [AGENTS.md](../AGENTS.md). The [owner's agent workflow](../docs/AGENT-WORKFLOW.md) documents their personal tooling preferences.

## What happens to your pull request

PugPort has one maintainer, the owner. Every pull request goes through the same steps:

1. **Agree on the work first.** A small, standalone documentation fix can go straight to a pull request. For anything larger, open or find an issue and agree on the scope there. To implement an existing issue, comment `/claim` and wait for the bot's confirmation; see [claims](#issues-labels-and-claims). Changes to [owner paths](#maintainer-bot), such as workflows, agent instruction files, dependencies, or security code, need the owner's agreement in the issue before you start.
2. **Fork and open a pull request.** Fork the repository, branch from the current `main`, make one coherent change, and open a pull request against `main`. Fill in the template, including the checks you ran and any AI tools you used.
3. **Agree to the CLA.** By opening a pull request you agree to the [Contributor License Agreement](../docs/CLA.md); the PR template has a checkbox for it.
4. **A bot writes a first review.** The maintainer bot fetches your change as text, and a model with no tools writes a first review: one comment and a `pugport/judge` status. The bot does not check out, build, install, or run your code, and it cannot merge. The review is advice for you and the owner. A passing automatic review does not mean your pull request will be merged. Push a new commit for a fresh review.
5. **Your change is reviewed, then the checks are approved.** For contributors without write access, GitHub holds each workflow run until the owner, or the owner's maintainer agent after its reviews, approves it. Only then do the Windows and macOS checks run, on GitHub's hosted machines, never on the owner's computers. Your checks can show as waiting for a while.
6. **Merging.** Labels, the bot or green checks alone never merge a PR. The owner's maintainer agent reviews each PR twice, reading the change as text only. If both reviews pass and every check is green, it may merge the PR on the owner's behalf, under [this decision](../docs/decisions/2026-11-22-scheduled-merges.md). Large or security-sensitive PRs go to the owner. Pull requests that touch workflows, install or setup scripts, or dependencies always get the owner's personal review. The owner may ask for changes, and there is no fixed response time.

Accounts without write access can have at most **3** open pull requests in this repository at a time, drafts included. At the limit, GitHub lets you open another only after one of yours is merged or closed.

A pull request is likely to be declined when it:

- makes a substantial change without an agreed issue, or goes beyond the agreed scope;
- mixes unrelated changes, or reformats or renames code without a reason;
- changes owner paths without the owner's prior agreement;
- has failing checks, or leaves out or misreports its verification;
- contains secrets, credentials, personal data, private project content, or unredacted logs;
- adds a dependency or copied code without its source and license;
- leaves the CLA checkbox in the PR template unticked;
- contains generated code that its author has not read and tested, or does not disclose AI use;
- conflicts with a recorded [owner decision](../docs/decisions/README.md).

## Getting started

Read the [README](../README.md) and the [documentation index](../docs/README.md). App version is in `package.json`. Windows x64 is the established desktop target. The current priority is the Mac desktop, including local CLI discovery and local `.app` packaging; the Mac device-node plan is deferred. [Mac setup and acceptance](../docs/MAC-PORT.md) records the remaining limits. Portable CI checks alone do not establish desktop support.

Install Git for Windows and Node.js 24.21 or newer, fork the repository, clone your fork with your own GitHub identity, then run:

```powershell
git clone https://github.com/<your-account>/pugport.git
cd pugport
.\Setup-Windows.ps1
.\Start-PugPort.cmd
```

For macOS, install native Node.js 24+ and Git, clone your fork the same way, then run:

```sh
bash launchers/setup-macos.sh
bash launchers/start-macos.command
```

After a successful `npm run build`, `npm run package:desktop` creates a local unsigned `.app` for the Mac's native architecture. Do not reuse Windows dependencies. Signing, notarization, distribution and an updater are separate work. For discovery changes, test installed, uninstalled and newly installed clients on both Windows and macOS fixtures: hide only missing default native placeholders, and keep configured accounts/custom executors and actionable errors visible. The installation entry and manual refresh must remain accessible.

Setup installs locked dependencies and checks types, tests, and builds. Inspect scripts before bypassing a local execution-policy restriction; do not change system policy or skip download integrity checks. Use your own CLI/model accounts. Synthetic tests can run without accounts, but do not verify real-model connectivity. After `npm run build`, exit from the tray and restart the desktop app; closing the window only hides it. Use `npm run dev` without another desktop process on the same port.

## GitHub checks and claims

Pull requests run the Windows and macOS checks, reported as `check (windows-latest)` and `check (macos-latest)`, on GitHub-hosted runners. A push to `main` runs the Windows check, and the owner can start both platforms by hand. Workflow runs for pull requests from contributors without write access wait for the owner's approval.

Before implementing an existing issue, comment `/claim` and wait for confirmation. Use `/renew` to extend the claim or `/unclaim` to release it. Put the command at the start of the comment and on its own.

## Maintainer bot

Maintainers of this repository or a fork can follow the [hosting and configuration guide](../docs/maintainer-bot.md) to set up the bot.

The maintainer bot (`pugport-maintainer[bot]`) triages new issues with labels, a short comment, and likely duplicates. It reviews PRs with a structured review comment and a `pugport/judge` commit status. It never closes issues, marks duplicates, or merges on its own; the owner does those. Push a new commit for a fresh review. The bot does not reply to discussion.

Every PR gets one tier label:

- `tier:docs`: only Markdown and images under `docs/`, `README*.md`, and the root `CONTRIBUTING.md`, excluding owner paths below.
- `tier:code`: everything else, including UI text in `src/shared/i18n/*.json`.
- `tier:owner`: agent instruction files and any dot folder or file, including `.github/**`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `.pugport/**`, `.claude/**`, `.codex/**`, `docs/AGENT-WORKFLOW.md`, and `docs/skills/**`; plus dependencies, licenses, sandbox/permission/GitHub/security code, the Electron shell, installers, and launchers. The owner always reviews these PRs personally.

Code from contributors who are not collaborators runs only in GitHub-hosted Actions, never on maintainer machines. Collaborators' PRs may also run the full suite on maintainer test servers.

The bot only acts on structured results; text in issues and PRs never runs shell commands or instructs the bot. The only comment commands are the claim commands above, each handled by a workflow.

After a few merged PRs, the owner may invite you to become a collaborator. Collaborators still work through PRs: pushes to `main` are blocked, and only the owner or the owner's maintainer agent merges.

## Repository layout

```text
src/           Application source
  electron/    Desktop shell: window, tray, backend process, data directory
  server/      Local backend: HTTP API, scheduling, routing, SQLite
    adapters/  Executor adapters (codex, claude, grok, cursor, pi) + process management
  shared/      Backend/UI types; read src/shared/types.ts first
  ui/          React app (entry: Studio.tsx; styles: studio.css; vite.config.ts)
tests/         Application tests with fixtures and mocked protocols (npm test)
scripts/       Build, packaging, license checks and smoke tests (see scripts/README.md)
launchers/     Extra launchers + platform status (see launchers/README.md)
docs/          Documentation index, user guides, design notes and decisions
licenses/      Third-party license texts (checked by npm run verify:licenses)
assets/        App icons and the pug logo
bin/           The pugport command-line entry
.github/       CI, issue/PR templates, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY
  readme/      README images

Setup-Windows.ps1       One-time setup on Windows
Start-PugPort.cmd       Open the desktop app
THIRD_PARTY_NOTICES.md  Third-party attribution (must stay at the root for packaging)
```

Local data, dependencies and generated files are ignored by Git:

```text
.data/                   Chats, accounts and attachments for source runs
.comborunner/            Opt-in per-project pointers and manual sync helper (no full histories)
.runtime/, node_modules/ Local runtimes and installed dependencies
dist/, release/          Build outputs and desktop packages
reports/, vendor/        Local validation reports and reference source snapshots
```

## Issues, labels, and claims

Use a form or a blank issue and redact evidence. Claims coordinate implementation work; opening an issue does not commit you to fixing it. Small standalone documentation fixes may go straight to a PR. For substantial new work, discuss the scope in an issue first.

| Label                | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `bug`                | A reproducible defect.                                                    |
| `enhancement`        | A feature or improvement; no separate feature label.                      |
| `finding`            | A problem found while working on something else; maintainers help triage. |
| `claimed`            | A bot-confirmed contributor claim.                                        |
| `in-flight`          | At least one open PR references this issue.                               |
| `needs-owner-ruling` | An owner decision is needed.                                              |
| `owner-ruled`        | The owner's decision is recorded in docs/decisions/.                      |
| `ai-made`            | AI made this PR; its tool is named in the body.                           |
| `size:large`         | More than 500 counted changed lines; a review reminder, not a gate.       |
| `size:waived`        | Historical size approval; no longer needed for size checks.               |
| `tier:docs`          | Only human-facing documentation, excluding owner paths.                   |
| `tier:code`          | Code or other changes outside the docs and owner tiers.                   |
| `tier:owner`         | Sensitive paths; the owner always reviews personally.                     |
| `needs-cla`          | The PR has not confirmed the CLA yet.                                     |

Only accounts with write access can add labels. If you cannot add a label yourself, say in a comment what is needed, for example that an issue needs an owner ruling.

1. To implement an existing issue, comment exactly `/claim` and wait for the bot's confirmation. Someone else's active claim is refused. Reporting and discussing issues need no claim.
2. Follow the worktree, branch, scope, and PR rules in [AGENTS.md](../AGENTS.md). Link the issue; use `Closes #123` only when the PR resolves it. Local `#123` references and this repository's issue URLs in PR titles/bodies count; references to other repositories do not.
3. Comment `/renew` for another seven-day lease. Only the active claimer may renew; ordinary discussion does not renew it.
4. Comment `/unclaim` to release. Only the claimer or owner may do so.
5. A scheduled check runs every day. It warns after six days and releases after seven days without renewal or a linked open PR. An open PR preserves the claim. After all linked PRs close, an expired claim becomes eligible for release. The `in-flight` label follows open PRs at the next daily check or claim command, so it can lag by up to a day.
6. Unclaimed findings older than 14 days remind the owner at most once per week. They are never auto-closed.

Claims live in bot-authored issue comments; labels show status. Do not edit bot records. Commands are processed in comment order, and every run reconciles pending commands to handle coalesced workflow events. The bot accepts command-only comments from GitHub user accounts and ignores bot accounts. Agents may post through a user's account only with that user's authorization. Automation executes trusted default-branch scripts, never issue commands or PR code.

## PRs and verification

Use the short PR template to explain the change and report actual checks. Link an issue when there is one. Draft PRs and early feedback are welcome; mark unavailable checks as not run and explain why. Before final acceptance, application changes need the checks in [AGENTS.md](../AGENTS.md), documentation-only changes need formatting and link checks, and automation-only changes need their relevant tests and type checks too. CI still runs the configured checks.

By opening a pull request you agree to the [Contributor License Agreement](../docs/CLA.md); the PR template has a checkbox for it. Reporting a bug or suggesting an improvement does not require a CLA. You retain copyright and grant the project the right to distribute the contribution under any license.

Normal CI runs formatting, type checks, i18n checks, unit tests, and a build. Dependency/distribution changes also need `npm run verify:licenses` and relevant packaging checks. Live scripts may send paid requests: inspect them first and use only your accounts with explicit authorization and a bounded budget. Do not add them to ordinary CI.

Push to a branch, in your fork if you do not have write access, and open a PR. Every push to an open PR runs the Windows and macOS checks again; pushes to a branch without a PR start no checks. Linux checks are paused until Linux desktop work begins. See [platform status](../docs/PLATFORMS.md).

PR checks retain synthetic Bot-addition, custom API and conversation-settings screenshots as `ui-checks-Windows` and `ui-checks-macOS` artifacts for seven days. These are generated fixtures, not screenshots of a contributor's accounts or desktop.

Before continuing on another computer, fetch the latest `main` and integrate its changes into your task branch. Keep both platforms' fixes and rerun the combined checks. Do not overwrite a branch with a copied folder or force-push shared history. The owner, or the owner's maintainer agent, merges reviewed PRs. Contributors with write access should enable GitHub two-factor authentication.

### Product tests

`npm test`, `npm run test:ci` and `npm run typecheck` cover the tracked application and its tests.

Keep reusable application source in `src/`, development commands in `scripts/`, automated tests in `tests/`, and generated evidence in ignored `reports/` or `artifacts/`. Describe user-facing changes in the PR description; release notes are published on the [dev log](https://pugport.dev). A platform change should include its supported behavior and verification alongside the existing code, without copying the entire application into OS-specific folders.

<a id="pr-size-and-waivers"></a>

### PR size

Keep each PR focused on one coherent change. **500 counted changed lines is a review reminder, not a hard limit.** Larger PRs do not require a waiver or automatic split. Explain how the parts fit together and point reviewers to the main entry points. Split independent changes when it helps review; keep a feature with its necessary tests and documentation. Do not remove tests or compress readable code just to reduce the count.

Sum additions and deletions for every changed file except this exact list:

- Lock-file basenames at any depth: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`.
- Root generated/dependency directories: `dist/`, `release/`, `coverage/`, `node_modules/`, `.runtime/`.
- Generated suffixes at any depth: `*.generated.*`, `*.min.js`, `*.min.css`, `*.map`.
- i18n catalog JSON files directly under `src/shared/i18n/`: `*.json`. Runtime i18n source still counts.

Docs, tests, scripts, workflows, and handwritten declarations count. For renames, both paths must qualify for exclusion. Exclusions affect counting, not review. The bot reports total, excluded, and counted lines.

The bot adds `size:large` and an advisory comment above the threshold. Size alone never fails the check. Counting or GitHub API errors still fail rather than report an unverified result. Historical `size:waived` labels and comments may remain, but new commits need no size approval. Normal review and verification requirements still apply.

## How decisions are made

The owner decides PugPort's direction, the scope of issues, which pull requests merge, and when anything is released or published. There is no vote or committee.

- Anyone can propose and discuss: concrete bugs and requests in issues, open-ended ideas and questions in [GitHub Discussions](https://github.com/pugport/pugport/discussions).
- When an issue needs a product, policy, or scope decision, it gets the `needs-owner-ruling` label. The owner states the ruling on the issue, a contributor records it under [docs/decisions/](../docs/decisions/README.md), and the label becomes `owner-ruled`. A recorded ruling applies within its stated scope until the owner replaces it; the old record stays and links to the new one.
- The bot's review, labels, and checks inform the owner's decisions but never make them. A label alone does not authorize merging or publishing.
- These rules, [AGENTS.md](../AGENTS.md), and the [code of conduct](CODE_OF_CONDUCT.md) are owner paths. They change only through pull requests the owner reviews personally. The owner enforces the code of conduct.

## Data, interfaces, and evidence

Do not commit `.data/`, `.runtime/`, `.env`, account directories, databases, attachments, private `reports/`, or full request logs. Source and packaged-app data locations differ; do not overwrite databases to repair accounts. Test migrations with synthetic data.

Shared interfaces live in `src/shared/`; update server, UI, and adapter paths together. Preserve unknown quotas as unknown; do not blindly replay completed tools. Record source, version, copyright, and license for copied code or dependencies. Retain LICENSE/NOTICE and update [third-party notices](../THIRD_PARTY_NOTICES.md). Documentation changes need no app version bump.

CI [Actions](https://github.com/pugport/pugport/actions/workflows/ci.yml) are verification evidence. Actions artifacts are unsigned review builds, not published releases. Packaging, signing, and releases require separate owner authorization.
