# macOS and Linux: plan

Status: historical plan updated 2026-10-21 with optional device folders, full-access writes and file transfers; hardware acceptance remains separate. The original audit was 2026-10-10. PugPort ships for Windows today; a macOS desktop and Linux/macOS headless **device nodes** are in progress (see "Device nodes" below). This plan is kept as historical notes; the shipped Windows and Mac desktop update paths are current and covered in [PLATFORMS.md](PLATFORMS.md), [RELEASING-WINDOWS.md](RELEASING-WINDOWS.md) and [RELEASING-MAC.md](RELEASING-MAC.md).

## Where things stand

- **The backend already runs headless.** `node dist/server/main.js` needs no Electron, and shutdown already handles
  SIGTERM (what launchd and systemd send). The adapters already have POSIX branches (process groups, `/bin/sh`,
  X_OK checks). Most of the work is folders, file permissions, Trash, process trees and executable discovery.
- **Packaging** was planned as `@electron/packager` in `scripts/package.mjs`, hard-coded to win32/x64 with an `.ico`, producing
  a portable ZIP, with no electron-builder or NSIS. Later the Windows release moved to an electron-builder NSIS per-user
  installer and the Mac to the ad-hoc signed release feed in `scripts/release-mac.mjs`; see [RELEASING-WINDOWS.md](RELEASING-WINDOWS.md)
  and [RELEASING-MAC.md](RELEASING-MAC.md).
- **CI** already runs `test:ci` on `macos-latest`, so a macOS smoke job can be added there.

## Problems found (fix before running on macOS/Linux)

| Problem | Where | Effect |
|---|---|---|
| Folder fallbacks assume `LOCALAPPDATA` | `api-providers.ts` (secrets), `local-memory.ts`, `memory-vectors.ts`, `image-search.ts`, `local-tools.ts`, `extensions.ts`, `file-manager.ts`, `media-analysis.ts`, `scripts/runtime-paths.mjs` | secrets land in `~/ComboRunner/secrets`, memory in `~/AppData/Local/ComboRunner`, … |
| `os.freemem()` used as available memory | `controller.ts`, `member-allocation.ts`, `media-performance-governor.ts`, `system-monitor.ts` | on macOS it counts only free pages, so runs get throttled |
| File manager protects Windows system folders only | `file-manager.ts` | `/System`, `/Library`, `/Applications`, `~/Library` unprotected |
| Discovery rejects symlinks and requires `.exe` | `discovery.ts` `directExecutable`, `native-accounts.ts` `requireDirectExecutable` | npm/Homebrew/Claude/Cursor installs are symlinks; isolated Codex accounts can't be created |
| Minimal PATH under launchd/systemd/Finder | — | npm CLIs (`#!/usr/bin/env node`) fail to start |
| Grok `--leader-socket` inside the account home | `native-accounts.ts` | likely over macOS's 104-byte socket path limit |
| CLIs spawned `detached` survive a backend crash | `adapters/process.ts`, `electron/backend-process.ts` | Windows has a job-object guard; POSIX needs a `ps`-based tree check and an owned-process record |

## Inventory by area

| Area | Windows today | macOS | Linux |
|---|---|---|---|
| App data | `%LOCALAPPDATA%\ComboRunner\…`, `appData/ComboRunner/data` | `~/Library/Application Support/PugPort/…` | `$XDG_DATA_HOME/pugport` (`~/.local/share/pugport`) |
| Cache | `%LOCALAPPDATA%\PugPort\Cache` | `~/Library/Caches/PugPort` | `$XDG_CACHE_HOME/pugport` |
| Secrets | icacls ACLs (`private-config.ts`, `native-accounts.ts`) | 0600 files in a 0700 folder + owner/mode check | same as macOS |
| Trash | PowerShell `SHFileOperation` (`recycle-bin.ts`) | JXA `NSFileManager.trashItemAtURL` (or `/usr/bin/trash` if present) | freedesktop Trash spec in plain Node (`info/<name>.trashinfo` with O_EXCL, then `rename` into `files/`; refuse across filesystems, never copy-then-delete) — Ubuntu Server has neither `gio` nor `trash-put` |
| Process tree | CIM `Win32_Process` + creation-time check; job-object guard | `ps -axo pid=,ppid=,pgid=,lstart=` + start-time check | `/proc` or `ps`, same check |
| Executable search | `WindowsApps`, `%APPDATA%\npm`, Codex/Cursor/Claude install folders | `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin`, newest `~/.nvm/.../bin` | `/usr/local/bin`, `~/.local/bin`, npm/volta/bun/nvm folders |
| PATH for services | inherited | read once from the login shell (`$SHELL -ilc`) or set in the plist | set in the systemd unit |
| Account login window | PowerShell `Start-Process` console | `.command` file + `open -a Terminal`; headless: piped `--device-auth` | headless: piped `--device-auth` |
| Memory | `os.freemem()` | `vm_stat` (free + inactive + speculative + purgeable) | `MemAvailable` in `/proc/meminfo` |
| GPU | CIM counters, `nvidia-smi` | `ioreg -c IOAccelerator` "Device Utilization %" or unavailable | `nvidia-smi` or unavailable |
| Battery | CIM `BatteryStatus` | `pmset -g batt` | `/sys/class/power_supply` |
| Reveal in folder | `explorer /select,` | `open -R` | `xdg-open` on the folder |
| Protected roots | `SystemRoot`, `ProgramFiles`, `ProgramData`, `~/AppData` | `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/private`, `/opt/homebrew`, `~/Library` | `/bin`, `/boot`, `/etc`, `/lib*`, `/proc`, `/sbin`, `/sys`, `/usr`, `/var` |
| Memory sync helper | `.comborunner/sync-memory.cmd` | `sync-memory.sh` (0755) | same as macOS |
| Terminal command on PATH | PowerShell edits user PATH | symlink into `~/.local/bin` or `~/.zprofile` | symlink into `~/.local/bin` |
| Launcher for `pugport open` | `PugPort.exe` | `Contents/MacOS/PugPort` or `open -a PugPort` | the installed binary |
| Tray / badge | taskbar overlay, themed tray PNG | dock badge, menu-bar template image | tray icon (desktop only) |
| Windows-only, hide | job guard, taskbar identity, MSIX mapping, `.vbs`/`.cmd` launchers | — | — |

Already cross-platform: adapters and process groups, `resolveExecutable`, `openFolder`, the MCP server and terminal
client, single instance, login items, `node:sqlite`.

## Module boundary: `src/server/platform/`

One folder of small functions (no per-platform source trees). Each takes a `host` (platform, env, home,
`path.posix`/`path.win32`, a `run` function, fs) as its last argument, defaulting to the current machine, so macOS
and Linux branches are unit-tested on Windows.

- `host.ts`: `Host`, `currentHost()`, `capabilities(host)` → `{ trash, accountLogin, gpu, shortcuts }`.
- `dirs.ts`: `appDirs(host)` → `{ localData, secrets, extensions, memoryBase, vectors, imageIndex, fileMoves, runtime,
  cache, logs }`. Windows values must stay byte-identical to today's, fallbacks included.
- `secure-file.ts`: `restrictFile`, `restrictDirectory`.
- `trash.ts`: `moveToTrash(paths, signal, host)`.
- `process-tree.ts`: tree snapshot/kill and an owned-process record for crash cleanup.
- `executables.ts`: `searchDirs`, `findExecutable`, `isDirectExecutable` (POSIX: `realpath` + file + X_OK).
- `shell-env.ts`: login-shell PATH (macOS; cached, 3 s timeout).
- `system-stats.ts`: `availableMemory`, `onBattery`, `gpuPercent`, with pure parsers for `vm_stat`, `pmset`,
  `ioreg`, `/proc/meminfo`, `ps`.
- `terminal.ts`: open a login terminal per platform.
- `protected-roots.ts`: system folders per platform.

## Device nodes (macOS and Linux)

From the running main PC, use `pugport node add <ssh target> [--name <name>]` to install or update a node and pair it. It sends the local committed `main` as a Git bundle, so the node needs no Git credentials. SSH uses your existing config/agent in batch mode; run `ssh <target>` yourself once to trust the host and arrange key login. Design decision (2026-10-20): paired nodes have the same trust as your local tasks. Writes default on; `PUGPORT_PEER_READ_ONLY=1` opts out, and the old `PUGPORT_PEER_ALLOW_WRITE` is ignored. Design decision (2026-10-21): device folders are optional. Auto/build messages can act unless you select read-only; chat mode stays read-only. A folderless write uses `~/PugPort-Workspace`. Device-origin writes run with full access and network access, without storing project trust; pi is excluded from these writes. No folder-id allow-list, Codex-only/network-off rule or credential-isolation gate applies. See [the decision](decisions/2026-10-20-device-node-trust.md) and [device files](MAC-PORT.md#6-device-folders-and-files).

Updates stop the node service. Running tasks, or an installed old node whose task count is unknown, require `--now`. `--dry-run` runs nothing and prints the commands and setup script; it explains which settings are kept, but cannot inspect their remote values. Node 24.21.0 tarballs are pinned and SHA-256 verified. Dependencies are installed only when the lockfile/runtime key changes or `node_modules` is missing. No projects are synced.

Linux needs Git, curl, tar, a SHA-256 tool, make, g++, Python 3 and `loginctl enable-linger "$USER"`. macOS needs Command Line Tools (`xcode-select --install`) and a logged-in desktop session (auto-login for unattended starts). `pugport node install` installs `~/Library/LaunchAgents/com.pugport.node.plist`, with logs in `~/Library/Logs/PugPort/node.log`. On Mac, run `sudo pmset -a sleep 0` and `sudo pmset -a autorestart 1`, connect Tailscale, approve privacy prompts once, and keep node projects outside `~/Documents`. Pair/status support `--json`; install/uninstall only replace/remove marked service files and preserve data. A node answers `pugport node` on `127.0.0.1:4319` (`PUGPORT_PORT`, kept on reinstall) and refuses the desktop app's data folders, so the desktop app (4317) can run on the same computer. Detached executor shutdown still needs the real-Mac verification recorded in [MAC-PORT.md](MAC-PORT.md#7-hardware-acceptance-still-required).

A node is the backend started headless with `PUGPORT_ROLE=node`. It skips desktop-only work (image indexing,
memory indexing, page tests) unless turned on.

- **Network:** keep the 127.0.0.1 listener (4319 on a node, beside the desktop's 4317). Add a separate peer listener (e.g. port 4318) bound to
  the Tailscale address and accepting only `100.64.0.0/10` (optionally `tailscale whois`); LAN mode would need
  self-signed TLS pinned at pairing.
- **Pairing:** `pugport node pair` prints a short-lived code; the main PugPort exchanges it for a 32-byte token stored
  with `writePrivateConfig`; the node keeps only a hash.
- **Peer API:** `/peer/v1/info`, `/peer/v1/runtimes` (executors with quota), `POST /peer/v1/tasks`, status, result,
  cancel, SSE events — reusing `ExternalTasks`. macOS adds `/peer/v1/mac/shortcuts` (list/run) and allowlisted
  AppleScript files only, never arbitrary script text.
- **Main side v1:** one delegate target per node that calls the peer task API (the node routes by its own quota);
  later each remote executor becomes a `RuntimeTarget` with `environment: 'remote'`. Project folders don't exist on the
  node, so v1 runs chat-only tasks or folders present on the node.
- **Hosting:** only one PugPort should run the Slack gateway — add a "host Slack on" setting. Recurring schedules
  don't exist yet (only one-shot `notBefore`/`deadlineAt`); build them on the node.
- **Keep-alive:**
  - macOS: a LaunchAgent `~/Library/LaunchAgents/com.pugport.node.plist` (not a LaunchDaemon: Keychain, Shortcuts
    and Automation need the GUI session) with PATH, `PUGPORT_ROLE`, data dir, `RunAtLoad`, `KeepAlive
    {SuccessfulExit:false}`, `ThrottleInterval 10`, `ProcessType Standard`, `LimitLoadToSessionType Aqua`, logs in
    `~/Library/Logs/PugPort/`. Install with `launchctl bootstrap gui/$(id -u)`. Mac setup: auto-login, `pmset -a
    sleep 0`, `pmset autorestart 1`, approve privacy prompts once, keep node projects outside `~/Documents`.
  - Linux: a systemd user service (sketch below), plus `loginctl enable-linger $USER` so it runs without a login and
    starts at boot. On Ubuntu Desktop also stop auto-suspend (`systemctl mask sleep.target suspend.target
    hibernate.target hybrid-sleep.target`). Logs go to journald (`journalctl --user -u pugport-node -f`).
  - Wrapped as `pugport node install|status|pair|uninstall`; one `platform/service.ts` renders both the plist and the
    unit.

```ini
# ~/.config/systemd/user/pugport-node.service
[Unit]
Description=PugPort device node
Wants=network-online.target
After=network-online.target
[Service]
WorkingDirectory=%h/pugport
ExecStart=%h/pugport/.runtime/node %h/pugport/dist/server/main.js
Environment=PUGPORT_ROLE=node
Environment=COMBORUNNER_DATA_DIR=%h/.local/share/pugport/data
Environment=PATH=%h/.local/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10
# The whole cgroup (backend and every CLI, even detached ones) stops together: no orphaned CLIs on the node.
KillMode=control-group
# Covers the backend's ~40 s graceful shutdown.
TimeoutStopSec=60
[Install]
WantedBy=default.target
```

### Linux node specifics

- **Build the Linux node first.** Most non-Windows paths already match Linux (case-sensitive paths, `xdg-open`,
  `XDG_CONFIG_HOME`, process groups), there are no privacy prompts or Keychain, and CI already runs on
  `ubuntu-latest`; the platform module gets proven before the Mac.
- **No orphan problem on the node:** systemd's cgroup holds every CLI, so the `ps`/`/proc` tree work is only needed for
  the desktop app.
- **Memory:** on Linux `os.freemem()` already reports MemAvailable in current libuv (verify once); the throttling issue
  is macOS-only.
- **Missing packages on Ubuntu Server:** `unzip` (replace the `unzip` call in `extensions.ts` with `adm-zip`, already a
  dependency) and `python3-venv` (MarkItDown setup).
- **Grok socket path** fits (about 95 bytes, under Linux's 108).
- **Tailscale timing:** a user unit can't order itself after the system `tailscaled`; the peer listener retries until
  the 100.x address exists (or binds `0.0.0.0` and accepts only `100.64.0.0/10`), plus `ufw allow in on tailscale0
  to any port 4318`.
- **Codex/CLI sandboxes on Ubuntu 23.10+:** AppArmor blocks unprivileged user namespaces, which bubblewrap-style
  sandboxes need — verify on the box.
- **Roles on the box:**
  - Slack and scheduled tasks: need the "host Slack on" choice and recurring schedules (new feature).
  - Extra swarm capacity: the remote delegate executor; chat-only or node-local folders until file sync exists.
  - Heavy media jobs: `ffmpeg` from apt, optional CUDA execution provider later; media must be on the node's disk or
    a mounted share — v1 does not stream files over the peer API.
  - Sandbox machine: a second unit under a dedicated unix user (e.g. `pugport-sbx`: no sudo, own home, none of your keys),
    its own pairing token; route high-permission presets only there.
  - Local models (if it has a GPU): run Ollama / llama.cpp / vLLM on localhost and add an "OpenAI-compatible local
    endpoint" API preset (none exists today).

## Second Claude and Cursor accounts

Added 2026-10-11 for Windows (`native-accounts.ts`). Each managed account is an empty folder below the app's
`accounts` directory; the default login of each CLI is never read, copied or changed.

| | Windows (implemented) | macOS | Linux |
|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR=<account>`: login in `.credentials.json`, account record (`oauthAccount`) in `.claude.json` | same variable, but the login goes to the Keychain. Unverified whether each config folder gets its own Keychain entry; the feature is not blocked, and a shared entry would show as the duplicate-identity warning. **Verify on a real Mac.** | same as Windows (file credentials), not tried |
| Cursor CLI | `APPDATA=<account>\AppData\Roaming` (login in `Cursor\auth.json`), `CURSOR_CONFIG_DIR=<account>\.cursor`, `AGENT_CLI_CREDENTIAL_STORE=file` | blocked: the default store is the Keychain (`cursor-access-token` / `cursor-user`), shared by every account. `AGENT_CLI_CREDENTIAL_STORE=file` moves it to `~/.cursor/auth.json`, which would also need `HOME` moved | blocked: the login is `$XDG_CONFIG_HOME/cursor/auth.json`; moving `XDG_CONFIG_HOME` has the same kind of side effects as `APPDATA` on Windows and needs its own pins and a Linux login terminal |

Paths for Cursor come from the CLI bundle (`cli-credentials` and `cursor-config/paths`, version 2026.10.01). The
moved `APPDATA` is inherited by every tool the agent runs, so three keep the real one when not already set:
`NPM_CONFIG_PREFIX` (npm's built-in `prefix=${APPDATA}\npm`), `PYTHONUSERBASE` and `GH_CONFIG_DIR`. A custom
`prefix` in `~/.npmrc` is overridden by that variable for the second account's runs. Other programs that keep
settings under `%APPDATA%` (VS Code, `pip.ini`, `go env -w`) see the account's empty folder. Cursor's chat data
(`~/.cursor/projects`) and MCP config stay shared, as for the default login. A second Claude account does not see
`~/.claude` (global `CLAUDE.md`, settings, skills, plugins, user MCP servers): Claude keeps all of that in its config
folder.

## Order of work (Windows behaviour unchanged at every step)

1. S: `platform/host.ts` and a `fakeHost()` test helper; pin today's Windows outputs (folders, discovery, icacls and
   taskkill arguments, generated PowerShell scripts) before moving code.
2. M: `dirs.ts`, then move all folder logic to it.
3. S: `secure-file.ts`.
4. M: `executables.ts` and `shell-env.ts`.
5. M: `system-stats.ts`.
6. S: safety and copy: protected roots, bridge tool text (Trash name, example paths), Pi tool list without
   `powershell` off Windows, `.sh` memory helper, reveal-in-folder, VS Code `mcp.json` path, image default folders,
   lock-file start time.
7. M: `trash.ts` for macOS/Linux plus a capability gate for the recycle tool.
8. M: `process-tree.ts` for POSIX and the owned-process record.
9. M: account login — piped device auth first (both nodes need it), then the desktop terminal variants
   (`.command` on macOS, `x-terminal-emulator` on Linux); capability flags; short Grok socket path on macOS.
   9b. S: replace `unzip` with `adm-zip`.
10. L: node mode, built against Linux first — role switches; peer listener, pairing and routes; `pugport node …` with
    `platform/service.ts` (unit + plist); Nodes page and remote delegate executor on the main side;
    Shortcuts/AppleScript tools (Mac); choosing the Slack host.
11. M: macOS desktop polish and packaging (dock badge, menu-bar icon, `before-quit` vs. logout, `.icns`, ad-hoc
    signing); can wait until the move. Historical: the ad-hoc signing step has since shipped for Apple Silicon release
    builds through `scripts/release-mac.mjs`; see [Mac releases](RELEASING-MAC.md).

## Testing without a Mac

- Pure functions with an injected `host`; assert macOS paths only through `host.path` (Windows `node:path` writes
  backslashes).
- Test generated text directly: JXA script, `.command` file, plist XML, systemd unit.
- Test parsers with captured `vm_stat`, `pmset`, `ioreg`, `/proc/meminfo` and `ps` output.
- Add macOS/Linux twins of today's win32-only tests.
- Add a `macos-latest` smoke job in CI: build, start `node dist/server/main.js` with `PUGPORT_ROLE=node` and temp
  folders, check `/api/state` and a pairing round trip, trash a temp file, kill a synthetic process tree with a
  grandchild, `plutil -lint` the plist.

To verify once on the Mac: whether `/usr/bin/trash` exists, Codex's default credential store, Grok's socket path
handling, the `ioreg` GPU key name, and whether two `CLAUDE_CONFIG_DIR` folders get separate Keychain entries.

### Device file transfers (2026-10-20)

The main keeps device tasks in a general chat. `deviceFolder` names a folder on the other computer (`~/` is expanded there), independent of local project roots. MCP callers need a write-anywhere ceiling or the user's always-writable override; local containment rules remain unchanged.

Chat attachments, MCP `dispatch_task` `files` and the online Devices card's **Send files…** action stream local files to the node's `<home>/PugPort/Received/from-<safeSegment(main name)>/` on every OS. This avoids macOS LaunchAgent TCC restrictions on Downloads, where the service cannot show a permission prompt. Executors return files with whole `PUGPORT_SEND_FILE: /absolute/path` lines, stripped from the answer after validation. Each file is checked separately: valid files are returned and refused files are named with their reason. The main downloads by file id to the user's `Downloads/PugPort/<device name>/` and lists saved paths. Both directions enforce regular-file/protected-root checks, safe names, unique destinations, 2 GiB per file, sender-side 16 files / 4 GiB per task and a 2 GiB free-space reserve at the receiver. Transfers have a 60-second idle deadline; SSE event streams have no total request deadline.

When macOS blocks reading a `PUGPORT_SEND_FILE` file (EPERM/EACCES), the reply names the file and directs the user to **System Settings → Privacy & Security → Full Disk Access** to add the real Node executable path printed by `pugport node status`, then retry. The hint also prints that path from the running node process. `~/pugport/.runtime/node` is a symlink to `node-v*/bin/node`; macOS grants access to the real binary. The path changes when the bundled Node version changes, so allow the new path after an update. Desktop and Documents are common protected locations. An older device without file uploads must be updated first: `pugport node add <ssh target> --now`.

The node reports whether it accepts writes in status and peer info. New protocol fields are optional; older strict nodes that reject them need `pugport node add <target> --now` from the main. Dispatch request ids prevent duplicate tasks on retries. Delegation, agent-bridge device writes and rerun-as-write remain deferred. Real Mac and Tailscale transfer acceptance still requires hardware testing.
