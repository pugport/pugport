# Maintainer bot

PugPort can host a GitHub maintenance bot for one repository, including a fork. It polls issues and pull requests, suggests issue labels and likely duplicates, and reviews PRs with a no-tools judge. The bot publishes review comments and a `pugport/judge` commit status when its mode and credentials allow it. It sends decisions requiring a maintainer to the desktop Inbox. It never closes issues, marks duplicates, or merges on its own. A merge requires an explicit owner action and a fresh check of the PR head and gates.

The [contribution tiers](../.github/CONTRIBUTING.md#maintainer-bot) distinguish documentation, code, and owner-reviewed changes. Code from non-collaborators never runs on maintainer computers or test servers, even after an owner click. The PR judge receives bounded text with no tools; an optional full-suite runner accepts trusted collaborator heads only.

## Choose where it runs

In **Settings → Devices → GitHub**, select **Off**, **This computer**, or a paired device. Off is the default. A selected device polls and judges while the desktop can be closed; the desktop mirrors pending cards to the Inbox when it reconnects. Full-suite commands and owner merge actions run on the desktop. The local host stands by when a device is selected.

Hosting on a device has a six-hour lease. The desktop renews it at startup, after each successful probe of that device, and every 30 minutes. When the lease expires, the host stops both polling and writing until renewed. Keep the desktop available for renewal if continuous hosting is needed. The Devices row shows mode, last poll, App readiness, judge totals, false passes, and up to 20 recent events.

## Desktop configuration

Create `maintainer.json` in the desktop's PugPort data directory. A valid configuration is required to start hosting. If a host is already selected, Off remains available even when the configuration is missing or the status request fails. This is separate from the secrets folder described below. No environment variable or feature flag enables the bot.

This synthetic example uses a POSIX path; on Windows use absolute Windows paths with JSON backslash escaping or forward slashes:

```json
{
  "repository": "example-org/example-project",
  "projectPath": "/srv/projects/example-project",
  "requiredChecks": ["ci", "CLA"],
  "fullSuite": {
    "argv": ["node", "/srv/maintenance/run-suite.mjs", "{sha}"],
    "cwd": "/srv/projects/example-project",
    "timeoutMinutes": 120
  }
}
```

Only `repository` is required. `projectPath` identifies the local project whose gates apply. `requiredChecks` names required CI checks. Check names are case-sensitive; the bot treats the check named exactly `CLA` as the CLA check. Omit `fullSuite` if no trusted suite command is configured. Its `cwd` must be absolute, its timeout is 5–240 minutes (default 120), and exactly one argument must equal `{sha}`. PugPort substitutes that argument with the exact commit SHA and invokes the command without a shell. The command must exit zero and print a final JSON object with `sha`, `tests`, `passed`, and `failed`; `failingFiles` and `minutes` are optional. A nonzero exit or invalid result is an error, not a passing suite.

The host saves its selection and lease in `github-host.json` in its own data directory. Local evidence goes to `maintainer-audit.jsonl`; pending cards and progress survive restarts in the application store. Configure GitHub CLI read access and a supported no-tools executor on the host. Owner merge actions use the desktop's signed-in GitHub CLI account; bot writes require the App credential below.

## Pin the judge to one executor

Without `judge`, each review and issue triage goes to whichever ready executor automatic routing picks, as long as it can run without tools. That can be a paid subscription. To keep every run on one card, for example a local model, add `judge` to `maintainer.json`:

```json
{
  "repository": "example-org/example-project",
  "judge": { "executor": "api-custom", "model": "pugport-custom/example-coder", "maxPromptKB": 96 }
}
```

- `executor` is the card's id on the computer that hosts the bot, the same id a scheduled task stores. A free source added with a custom address gets `api-custom`; a Custom API card gets `api-custom-api`. A second card of the same kind gets `-2`, then `-3`.
- `model` is the model id the card lists, the same value a scheduled task stores. A free source with a custom address prefixes the server's model id with `pugport-custom/`.
- `fallback` is `"none"` (the default) or `"automatic"`.
- `maxPromptKB` (32–400, default 400) caps the review prompt in kB (1,000 bytes). The judge drops related tests first, then base files, largest first, and lists what it left out. If the diff still does not fit, the review is BLOCKED as too large. As a rough guide, allow 2.5 bytes per token and leave room for the reply: about 64 for a 32k-token context window and about 128 for 64k. The default is too large for those models. The cap applies to PR reviews only; an issue triage prompt stays under 25 kB.

The pin covers every no-tools run of the bot: PR reviews and issue triage. Each pinned run is read-only and has no tools, no project context and no memory, the same as an unpinned run. It never moves to another card, never relays after a failure and never escalates.

**Fail-closed rule.** With `fallback` left at `"none"`, the bot runs nothing while the pinned card is missing, disabled, not installed or not ready, cannot run without tools, needs a new sign-in, is rate-limited, or does not list the model. When a pinned run ends without an answer, PugPort checks that card again. If the card is now unavailable, the run gives no verdict either. Then:

- The PR keeps a pending `pugport/judge` status that reads _Review unavailable for now; it will be retried_. It gets no PASS, FAIL or BLOCKED and no comment.
- **Settings → Devices → GitHub** shows _Pinned judge unavailable_ and the reason. If the card or model id is wrong, the reason lists the available ids.
- The review stays queued, and each poll (about every 2 minutes) checks the card again. When the card is ready, the pending status returns to _Review queued_ and the review runs on the pinned card.

A card that cannot run without tools, such as Codex or Cursor, is refused even when it is ready. `"fallback": "automatic"` brings back automatic routing, which may choose a paid subscription, but only while the pinned card is unavailable. A run that fails while the pinned card is still ready, or that takes longer than 20 minutes, is handled like any other judge failure: a BLOCKED review for the maintainer.

The bot reads only the first line of the reply as the verdict. A reply whose first line is not a bare `PASS @ <sha>`, `FAIL @ <sha>` or `BLOCKED @ <sha>` for the reviewed commit is INVALID and goes to the maintainer. Whitespace such as spaces and tabs before and after the verdict on that first non-empty line is accepted, for example `  PASS @ <sha>` or a tab-indented `FAIL @ <sha>` with trailing spaces; anything else around the verdict, including Markdown emphasis, backticks, quote or list markers or lowercase words, is still INVALID. After three INVALID verdicts in a row, judging pauses with or without a pin: the Inbox gets a card, and **Settings → Devices → GitHub** shows the pause with a button to resume. If a local server returns the model's reasoning as part of the reply text, for example inside `<think>` tags, turn that off on the server.

The desktop reads `maintainer.json` at startup, when you choose a host, and when it renews the lease every 30 minutes. A paired device receives the pin with that hosting request. It checks the id and model against its own cards, and it must run a PugPort version that knows the option.

### Example: a local model server

For an OpenAI-compatible server on the hosting computer at `http://127.0.0.1:8000/v1`:

1. On the hosting computer, add the server under **Executors** as a free source with a custom address. Check that the card is ready and lists the model.
2. Put the card id, the model id and a prompt cap that fits the model's context window in `judge`, as in the example above.
3. Select the host again, or wait for the next renewal.

PugPort asks a free source's server for its models whenever it refreshes the card, so a stopped server makes reviews wait. A Custom API card pointed at the same server also works, but PugPort does not probe that server, so the card can still look ready after the server stops. The next review is then BLOCKED as a judge failure. Either way, a review never goes to a paid executor.

## Create a GitHub App

Create an App in the GitHub settings of the account or organization maintaining the repository. Choose your own App name. Disable the webhook; this bot polls. Grant these repository permissions:

| Permission      | Access         |
| --------------- | -------------- |
| Issues          | Read and write |
| Pull requests   | Read and write |
| Actions         | Read-only      |
| Checks          | Read-only      |
| Commit statuses | Read and write |
| Contents        | Read-only      |
| Metadata        | Read-only      |

Install the App on **only the chosen repository**. Generate a private key and save it as `github-app.pem`. Create `github-app.json` alongside it, with the App ID as a string:

```json
{
  "appId": "123456",
  "installationId": "789012"
}
```

`installationId` is optional; the bot can discover the repository installation. Place both files on the computer selected to host the bot:

| OS      | Secrets folder                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\ComboRunner\secrets`                                                                            |
| macOS   | `~/Library/Application Support/PugPort/secrets`                                                                 |
| Linux   | `$XDG_DATA_HOME/pugport/secrets`, or `~/.local/share/pugport/secrets` when `XDG_DATA_HOME` is unset or relative |

The full filenames are `<secrets folder>/github-app.json` and `<secrets folder>/github-app.pem`. Keep both readable only by the hosting user: mode `600` on macOS/Linux, and a user-only file ACL on Windows. The host rejects a private key readable by other users on POSIX systems. Never put these files in a repository, synced data directory, or logs. **Suspected key leak: generate a new private key on GitHub and delete the old one**, then replace the local key file.

## Shadow and live modes

A private repository uses shadow mode. The bot can judge PRs and retain local evidence, but only comments and judge statuses on PRs authored by the repository owner may be written. It does not bootstrap labels or apply tier/CLA labels in shadow mode. Shadow cards do not offer merge actions. Use a private test repository to inspect behavior first.

A public repository uses live mode. Writes still depend on App readiness, the active hosting lease, budgets, and project gates. Moving from private to public requeues open PRs within those budgets. Missing repository visibility keeps the bot off; missing App credentials do not authorize writes through a personal login.

## Stop the bot

| Switch                                               | What stops                                                               | What may continue                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Suspend the App in GitHub's installed App settings   | Bot writes authenticated by that App                                     | Polling and judging when separate read access is available; desktop owner actions use a separate credential |
| Devices → GitHub → Off                               | Hosting, polling, and bot writes; the desktop releases the selected host | An unreachable host may continue until its lease expires (at most six hours); probes retry the release      |
| Disable the repository's workflows in GitHub Actions | GitHub workflow automation, including CI and issue lifecycle workflows   | The host can still comment and set judge statuses; missing required checks prevent a merge card             |

Disable workflows together with one of the first two switches to stop both workflow automation and bot writes. To resume hosting after selecting Off, select the device or this computer again. The host resumes saved progress and deduplicates completed actions.
