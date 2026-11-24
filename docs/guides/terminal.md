# Terminal (`pugport`)

The `pugport` command lets you use your PugPort accounts, routing and task queue straight from a terminal — either in a full-screen interactive chat or with one-shot commands for scripts and other coding tools.

## Full-screen chat vs one-shot commands

- **Full-screen chat (`pugport`)** — running `pugport` with no subcommand in an interactive terminal (TTY) opens a full-screen terminal UI attached to the current folder's project.
- **One-shot commands (`pugport ask`, `wait`, `status`, `agents`, `tasks`, `cancel`, `doctor`, `open`, `node`)** — run a single action, print to `stdout` (with live status on `stderr`), and exit with a status code so you can pipe them in shell scripts or call them from another agent.

Except for `wait`, `doctor` and `node`, if the PugPort desktop app isn't running when you invoke `pugport`, the CLI starts it automatically in the background and waits up to 30 seconds for it to become ready (unless `PUGPORT_NO_START=1` is set). Commands other than `wait` can talk to a headless device node running locally on port `4319` when the desktop app isn't running.

## Help language

`pugport --help` and the chat's `/help` (with the slash-command descriptions) are shown in English, Simplified Chinese or Traditional Chinese. Other messages are not translated yet. Command names, flags and exit codes are the same in every language.

The language comes from the terminal's locale: the first of `LC_ALL`, `LC_MESSAGES` and `LANG` that is set to something other than an empty value, `C` or `POSIX`. When none of them is, the system locale is used (the usual case on Windows). A Chinese locale gives Chinese — `zh_TW`, `zh_HK`, `zh_MO` and `zh-Hant` give Traditional Chinese — and any other locale gives English.

```sh
LC_ALL=zh_CN.UTF-8 pugport --help   # Simplified Chinese
LC_ALL=en_US.UTF-8 pugport --help   # English
```

## Full-screen terminal chat

```sh
pugport              # open full-screen chat in the current folder (read-only by default)
pugport -w           # allow the agent to modify files in this folder (--write)
pugport -c           # continue the latest Terminal chat in this folder (--continue)
```

Inside the full-screen chat:

- Type `@` to mention a role or executor card, or `@@` to mention a paired device or external bot.
- Slash commands:
  - `/new` — start a new chat in this folder.
  - `/status` — display remaining usage limits across your accounts.
  - `/open` — open this conversation in the PugPort desktop window.
  - `/help` — show keyboard shortcuts and commands.
  - `/quit` (or `/exit`) — leave the terminal UI.
- Keyboard shortcuts:
  - `Enter` sends; `Shift+Enter` or `Ctrl+J` inserts a newline.
  - `Esc` cancels the currently running reply.
  - `Ctrl+C` cancels a running reply or clears the input line; pressing `Ctrl+C` twice within 1 second (or once on an empty idle prompt) or `Ctrl+D` exits the terminal UI. Any tasks still running keep going in PugPort.

## `pugport ask`

Send a task from the command line, stream live progress on `stderr`, and print the final answer to `stdout`:

```sh
pugport ask "Explain why this test fails"
pugport ask -w "Fix the failing import in the project"
pugport ask --agent Claude "Review the last commit"
git diff | pugport ask - "Review this diff for race conditions"
pugport ask --resume <conversationId> "Now add a unit test for it"
pugport ask --json "Summarize package.json"
```

### Options for `ask`

- `-w`, `--write` — allow modifying files in the current working directory. Without `-w`, `ask` runs **Read-only**.
- `--agent <name>` — pick a specific executor card or provider (such as `Claude`, `Codex`, or `Second Codex`). Omit `--agent` to let PugPort route automatically.
- `-` — read `stdin` (UTF-8 BOM is stripped automatically) and append it to the task prompt. Tasks can be up to **50,000 characters** in total.
- `-r <id>`, `--resume <id>` — continue the existing conversation `<id>` instead of starting a new terminal conversation.
- `--json` — print a single JSON object line on `stdout` when the command finishes.

### `--json` output fields for `ask`

When a local task runs and finishes, `--json` prints one JSON object with these fields:

| Field | Type | Description |
| --- | --- | --- |
| `taskId` | `string` | The workflow/task ID in PugPort. |
| `conversationId` | `string` | The conversation ID (pass to `--resume` to continue the thread). |
| `status` | `string` | Terminal task status (`completed`, `failed`, `cancelled`, `blocked` or `interrupted`). |
| `executor` | `string \| undefined` | The executor card or provider that ran the task. |
| `model` | `string \| undefined` | The model ID used for the run. |
| `result` | `string` | The final assistant reply text. |
| `error` | `string \| undefined` | Error message when the task did not complete cleanly. |

When a message is queued without starting a local task immediately or handed directly to a paired device or external bot, `--json` prints:

| Field | Type | Description |
| --- | --- | --- |
| `conversationId` | `string` | The conversation ID where the message was posted. |
| `note` | `string \| undefined` | Status note from PugPort. |
| `queued` | `boolean \| undefined` | `true` when the message was added to the queue. |
| `handedTo` | `string \| undefined` | Name of the device or external bot that received the task. |

## `pugport wait`

Wait until any of 1–20 task IDs finishes or needs you. IDs contain only letters, digits and hyphens, with at most 80 characters each. The command never starts PugPort and never cancels a task, including when you press `Ctrl+C`.

```sh
pugport wait <task-id>... [--timeout <duration>] [--json] [--port <port>]
# Synthetic task IDs; replace them with IDs returned by dispatch_task:
pugport wait demo-task-1 demo-task-2 --timeout 25m
pugport wait demo-task-1 --json
```

The default timeout is 9 minutes. Use seconds (`90` or `90s`), minutes (`25m`) or hours (`2h`), from 1 second to 24 hours. `--port` selects a backend port. For an agent shell tool, run in the background if supported, or set its timeout to 10 minutes (`600000` ms) for the default wait.

Completion, failure, cancellation, blocked and interrupted states return immediately. Approval or confirmation triggers when the observed status changes, or when the task started less than 60 seconds before this wait. Older unchanged approval or confirmation states are shown as already waiting and do not trigger again. Approval detection can take up to 50 seconds. Temporary backend outages are retried until the timeout.

Output lists triggered tasks first; use MCP `task_result` to read the answer. `--json` prints one object with `outcome`, `waitedSeconds` and `tasks`; each task includes `taskId`, `conversationId`, `status`, `need`, `new`, `executor`, `model` and `error`. `new` indicates whether that task triggered this wait.

| Exit code | Meaning for `wait` |
| --- | --- |
| `0` | At least one task completed, failed or was cancelled. |
| `3` | At least one task needs you: approval, confirmation, blocked or interrupted. Takes priority over `0`. |
| `124` | Timeout; run the command again to keep waiting. Also returned silently if the parent process is gone. |
| `1` | Error, including an unreachable backend at startup or an unknown task ID. |
| `2` | Invalid arguments. |
| `130` | Interrupted by `Ctrl+C`; tasks keep running. |

## Other one-shot commands

- `pugport status [--json]` — shows each enabled account card and its remaining usage limit windows (the same summary shown in the system tray popup).
- `pugport agents [--json]` — lists enabled executor cards with their status, available models, supported effort levels, and current usage snapshot.
- `pugport tasks [--json]` — lists recent and active tasks across conversations with their status, executor, model and title.
- `pugport cancel <taskId> [--json]` — cancels a running or queued task by its `taskId`.
- `pugport doctor` — checks whether PugPort is reachable, whether the desktop and CLI versions match, whether `pugport` is on your `PATH`, and whether any enabled executor is in `error` or `auth-required` state.
- `pugport open` — starts the PugPort desktop app or brings its window to the front.
- `pugport node <subcommand>` — manages headless device nodes on Linux and macOS (`add`, `install`, `pair`, `status`, `unpair`, `uninstall`, `help`). See [Remote servers and devices](remote-servers-and-devices.md).

## Exit codes

For commands other than `wait` (whose codes are listed above):

| Exit code | Meaning |
| --- | --- |
| `0` | Completed (`ask` finished with `completed`, or `doctor` passed every check). |
| `1` | Task failed or was cancelled, PugPort could not be reached/started, or `doctor` found a version mismatch, missing `PATH`, or an executor in `error` / `auth-required`. |
| `2` | Invalid command-line arguments, empty task, task over 50,000 characters, or running full-screen `pugport` without an interactive TTY. |
| `3` | Task paused (`blocked` or `interrupted`, for example interrupted mid-run); you can continue it in PugPort. Waiting for approval does not exit; scripts need their own timeout. |
| `130` | Interrupted by `Ctrl+C` (`SIGINT`); `pugport ask` also cancels the running task in PugPort before exiting. |

## How `pugport` gets on `PATH`

- **Automatic for installed desktop copies** — when you run an installed desktop build (`resources/app`, outside macOS AppTranslocation or `/Volumes`), PugPort automatically adds `pugport` to your user `PATH` 3 seconds after first launch.
- **Manual toggle in Settings** — open **Settings** → **Connect** → **Use PugPort elsewhere** → **Terminal** → **Add to PATH** to add or remove `pugport` from `PATH` at any time, including from a source checkout.
- **How each platform sets it up:**
  - **Windows** — adds `<appRoot>\dist\bin` (which contains `pugport.cmd`) to your user `HKCU\Environment\Path` registry value and broadcasts `WM_SETTINGCHANGE`. Open a new terminal window to pick up the updated `PATH`.
  - **macOS and Linux** — creates a launcher script at `~/.local/bin/pugport` and adds `export PATH="$HOME/.local/bin:$PATH"` to `~/.zprofile` (macOS `zsh`), `~/.zshrc` (Linux `zsh`), `~/.bash_profile` or `~/.profile` (macOS `bash`), or `~/.bashrc` (Linux `bash`). For `fish` or other shells, Settings shows the exact `fish_add_path` or `export PATH` line to run.
