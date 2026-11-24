# macOS desktop setup and port status

Updated 2026-10-16. Release and update notes updated 2026-11-21. Current priority: **use PugPort directly on the Mac desktop**, with Apple Silicon and native arm64 Node 24 as the first validation target. The current cross-platform support table is in [PLATFORMS.md](PLATFORMS.md). The core Mac desktop path is locally verified; this does not mean every provider, native integration or release path is verified. This direction supersedes the older node-first ordering in `CROSS-PLATFORM.md`.

## 1. Current scope and evidence

The shared application now has Mac source launchers, native `.app` packaging, POSIX file links and Grok reply commands, Mac application/window menus and Cmd+Enter composer shortcuts. Startup and refresh scan for installed official CLIs on both Windows and macOS. Missing default clients stay out of the main account list; the installation entry remains available. Configured API accounts, managed accounts, custom executors and connection errors remain visible.

Verified locally on an Apple Silicon Mac during this work:

- Source desktop startup with native Node 24.
- Two explicitly authorized Codex requests: reading/writing in a temporary project path containing spaces and Unicode, and cancelling a running task. These checks cover Codex in that local configuration, not every provider or account mode.
- Targeted fixtures for CLI discovery across installation/removal, POSIX reply HTTP transport, Mac menus/composer shortcuts and process-group cleanup. Final whole-suite results belong in the change's verification record; targeted checks do not imply the whole suite passes.
- The native arm64 `.app` started to a connected workspace and passed normal/failure shutdown checks. The installed app's expanded and compact usage views showed only the three installed CLIs.

Remaining acceptance includes sustained desktop use, native integrations and other provider/account combinations. The Windows behavior has fixture coverage in this round but **has not been retested on a Windows computer**. No broad macOS support claim is established here; Apple Silicon releases are ad-hoc signed and self-update from the signed feed, and no notarization has been performed, as recorded in [PLATFORMS.md](PLATFORMS.md) and [Mac releases](RELEASING-MAC.md).

## 2. Design decisions

**2026-10-16:** desktop first. Each launch should discover the CLIs already installed on the computer and display their account/connection state. Missing default clients such as Cursor should not occupy the main list; installing them later should make them discoverable. Keep one shared source tree, clear setup instructions and focused changes suitable for future collaborators.

**Design decision, 2026-10-20:** a paired node is your own computer and has the same trust as a local task on the main computer. This replaces the earlier OPEN N2 push/delete and credential-isolation decision. Writes default on; `PUGPORT_PEER_READ_ONLY=1` opts out. The old `PUGPORT_PEER_ALLOW_WRITE` is ignored, including the `0` previously forced into SSH installations. No folder-id allow-list, Codex-only routing, network-off requirement or credential-isolation gate applies to paired device tasks. [Decision record](decisions/2026-10-20-device-node-trust.md).

A device folder is a path on that computer, including `~/...`. The main stores it as `MessageInput.deviceFolder` in a general chat and sends it as the peer protocol's existing `projectPath`. The node resolves and checks it: no filesystem root, home itself or protected folder. The folder is optional: a writable task without one uses `~/PugPort-Workspace`, created and checked on the device. Auto/build messages can act; chat mode or the read-only switch prevents writes. Device-origin writes use automatic tool approval and full access, including network access, without saving trust on the project. pi is excluded from these writes. The same rules apply when a node forwards to the desktop app. External MCP callers still need permission to write outside their own local roots; this ruling does not widen a caller's permission.

## 3. Set up, build and run on the Mac

Follow [AGENTS.md](../AGENTS.md) and [Contributing](../.github/CONTRIBUTING.md). Use native Node.js 24+ and Git; Apple Silicon uses arm64, not Rosetta. Keep the checkout outside synced/protected folders when possible, such as `~/Projects/pugport`. Do not copy Windows `.runtime`, `node_modules`, accounts or databases into a fresh Mac installation.

```sh
mkdir -p "$HOME/Projects"
cd "$HOME/Projects"
git clone https://github.com/pugport/pugport.git
cd pugport
node -p 'process.version + " " + process.arch'
bash launchers/setup-macos.sh
bash launchers/start-macos.command
```

[setup-macos.sh](../launchers/setup-macos.sh) installs locked dependencies and Electron, then runs `typecheck`, `test:ci` and `build`. A failed check stops setup; fix or record the failure before treating the checkout as verified. The launcher supports normal Homebrew Node locations when Finder provides a limited PATH. Verify a Finder double-click separately from Terminal startup.

Install and sign in to only the official CLIs you intend to use. On startup and refresh, PugPort checks the existing CLI installations and their reported state. Use **Install or connect a client** for missing clients, and **Refresh** after installation or sign-in. Managed subscription accounts open their official CLI sign-in in Terminal with an isolated profile directory. Discovering a binary, a cached model list or an account identity is not proof that a real model task will succeed. Connection tests can consume quota and require explicit authorization. Full second-account authentication and provider-specific Keychain behavior remain separate acceptance items.

After editing source, choose **Quit PugPort** from the application/menu-bar menu, then rebuild and restart:

```sh
npm run typecheck
npm run test:ci
npm run i18n:check
npm run build
bash launchers/start-macos.command
```

Closing the window keeps the app running. Stop the desktop before using `npm run start` for the backend/web alternative at `http://127.0.0.1:4317`. Source runs normally use the checkout's `.data/`; packaged apps use a separate per-user data location. Changing entry points can therefore show a different history. Back up data before deliberate migration, and keep runtime data out of Git.

### Local application bundle

After a successful build on the target Mac:

```sh
npm run package:desktop
```

The default target is the current Mac architecture. Apple Silicon outputs `release/PugPort-darwin-arm64/PugPort.app`; Intel outputs `release/PugPort-darwin-x64/PugPort.app` and requires a native Intel build. Copy the complete `.app`, which includes the runtime and license files. The packaging code understands `.app/Contents/Resources`, keeps target-native dependencies and generates an ICNS icon from the existing brand asset.

This is an **unsigned local validation bundle**. Release builds are made by `scripts/release-mac.mjs`, which ad-hoc signs them (`codesign --force --deep --sign -`) and uses no identity, with no Developer ID or notarization; the release builds self-update from the signed feed. No signing credentials are required for this local build. Do not count a successful packaging command as desktop runtime acceptance. Follow the package's license checks before sharing a build. See [Mac releases](RELEASING-MAC.md) for the release and update path.

## 4. Validation and remaining work

| Area | Implemented path | Still needs acceptance |
| --- | --- | --- |
| Discovery | Startup/refresh scans, installed-client cards, persistent install entry; Windows and Mac fixtures | Finder/login-shell PATH on varied installations, reported account state and real task connectivity per provider |
| Cancellation | Owned CLI launchers register before execution; normal cancellation, backend crash and forced stop wait for group cleanup before recovery | Arbitrary external helpers and descendants that detach into a different group are outside this protection; no general Mac process-tree containment guarantee |
| Desktop | Mac menus, Cmd shortcuts, deep-link handling, tray/popup changes and POSIX file links | Cold-start deep links, IME, clipboard, multiple displays/Spaces, sleep/lock/resume, sustained tray use |
| Accounts | Existing local CLI identities, real Claude quota metadata, explicit provider errors and managed Terminal login with isolated profile directories | Completing sign-in with a second identity for each provider, including Keychain behavior |
| Files and system integration | Existing Trash, reveal, keep-awake and telemetry branches | External disks, case-sensitive APFS, permissions, Trash restore, login items and unsupported telemetry fallbacks |
| Packaging | Native arm64/x64 targets and `.app` layout/license checks; ad-hoc signed Apple Silicon release and signed update feed | Intel runtime validation; no notarization and no Intel desktop acceptance |
| Device node | Existing peer/service foundations; plan retained below | macOS LaunchAgent lifecycle, writable folder policy, transfers and cross-device acceptance |
| Grok Bot routine | Before a routine is sent, the running app is found by bundle id with `lsappinfo`. A stopped app is opened hidden with `open -g -j -b` and waited for with the Windows limits; a missing app ends the routine as needs-user with an install note (`platform/grok-bot.ts`) | PugPort starting the real Grok Bot.app, and a full routine reply on the Mac |
| Local model servers | Custom API context window and output limit can be set when a connection is added, on macOS only (`platform/api-limits.ts`); a local MLX server completed coding tasks through Pi with the resulting model metadata | Adding the connection in the running app and a full task through the Controller; free-source connections (Ollama, LM Studio, custom address) keep the fixed 32,768/4,096 limits |

Use guarded product tests through `npm test` or `npm run test:ci`; bare `node --test` may discover unrelated third-party tests. Test isolation in `src/server/platform/under-test.mjs` redirects user paths and prevents accidental real CLI/network use. Real-provider smoke tests are separate and require a bounded, explicitly authorized request budget.
## 5. Work order

1. Finish Mac desktop acceptance: startup, installed-client discovery, real tasks, cancellation, tray/windows, paths and account state. Preserve Windows behavior in shared code.
2. Validate the native local `.app`; complete remaining provider and platform checks with explicit scope and evidence.
3. Historical: the deferred node plan below resumes when requested; ad-hoc signing and the signed-feed automatic update have since shipped for Apple Silicon releases, while Developer ID signing and notarization have not, and Intel desktop acceptance remains open.

## 6. Device folders and files

The 2026-10-20 implementation replaces the deferred N2-N4 file and write gates. Device messages and MCP `dispatch_task` can choose a folder on the device and explicitly request writes. The 2026-10-21 ruling makes the folder optional. The task origin is `device`; writable tasks route to an executor capable of automatic commands and run with your full local-task access. Delegation, agent-bridge device writes and rerunning device tasks with write access remain round 2 work.

Files travel in authenticated streams, separate from the JSON API: chat attachments, MCP absolute local `files`, and the online device card's **Send files…** action use the same upload path. On every OS the node saves them in `<home>/PugPort/Received/from-<safeSegment(main name)>/`. A macOS LaunchAgent cannot write Downloads without TCC permission and cannot show its permission prompt, so node uploads use this home folder instead. Task uploads finish before task dispatch; saved paths are added to the task text. File names and computer names are sanitized for all supported operating systems. Senders enforce 2 GiB per file and 16 files / 4 GiB per task; the receiving route checks each file's size and retains 2 GiB free space. Interrupted or mismatched uploads leave no final file; partial files older than one day are removed on the next receive in that folder. Transfers use a 60-second idle timeout; ordinary peer requests retain a 60-second deadline, excluding SSE event streams.

To send a file back, the executor puts a whole line `PUGPORT_SEND_FILE: /absolute/path` in its final answer. The node scans the retained full output of every task step once at settlement, strips these lines, checks real paths and regular files, refuses protected paths and untrusted tasks, and records file identity and size. The authenticated download route accepts file ids and checks task ownership and the recorded identity. The main saves returned files under `Downloads/PugPort/<device name>/` with unique names and shows their paths; a failed download gets one retry and a named error in the reply.

Return files are checked separately: valid files are sent and refused files appear as `<file name>: <reason>`. If macOS returns EPERM/EACCES for a file named in `PUGPORT_SEND_FILE`, such as one in Desktop or Documents, the reply names that file and explains that macOS blocked reading it. Open **System Settings → Privacy & Security → Full Disk Access**, add the real Node executable path printed by `pugport node status`, then retry. The hint also prints that path from the running node process. `~/pugport/.runtime/node` is a symlink to `node-v*/bin/node`; macOS grants access to the real binary. The path changes when the bundled Node version changes, so allow the new path after an update.

Only write task POSTs carry an optional `requestId`; an unreachable POST is retried once with the same body. The node stores deduplication records so retries reuse the existing task. A dispatch that throws is marked failed and can be retried; a reservation left uncertain by a crash still requires inspection. New protocol fields are optional. When an older strict node refuses new fields or its upload route is unavailable, update PugPort on that device first: `pugport node add <ssh target> --now`.

## 7. Hardware acceptance still required

Synthetic Windows tests do not establish Mac service or Tailscale acceptance. Verify these on your own devices:

- Terminal-installed LaunchAgent PATH, login startup, graceful shutdown and detached CLI cleanup.
- TCC, Keychain and firewall prompts, FileVault login, screen lock and sleep/wake.
- Pairing expiry/revoke, MagicDNS, IPv4 binding, reconnects and IPv6 expectations.
- Optional device folders, full-access writes, read-only opt-out, protected working-path refusal, caller ceilings and cancellation through app and MCP.
- Large steady and interrupted transfers in both directions, unique saved names and disk-space refusal.
- macOS Trash, deep links, menu-bar/Dock, shortcuts/Chinese IME and display behavior for desktop parity.

Full ordered log transport, Docker build tooling, approval relay, Developer ID signing, notarization and pre-login operation are separate work; the signed-feed automatic update has shipped for Apple Silicon releases, and remaining Intel validation remains open. They do not gate paired-device file tasks.

## 8. Rules for future Windows-side work

- Add no new Windows-only assumptions to shared paths. Keep Windows behavior while defining the Mac branch or an explicit capability refusal.
- Put platform-specific behavior behind `src/server/platform/*` helpers and test it with fakeHost inputs.
- Support POSIX paths in UI file links. Keep drive-letter/UNC support; never globally replace separators or expand Windows environment syntax on Mac.
- Generate commands per platform, including Grok Bot reply snippets, setup instructions and verification commands. Do not copy a PowerShell snippet into a Mac flow.
- Keep native account, device and packaging capabilities explicit. CI's Mac runner is not proof that the desktop, Keychain isolation or signing works.
- Keep real data, credentials and unredacted logs out of fixtures and Git. Preserve test isolation and data migration compatibility as Windows evolves.
