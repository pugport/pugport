# Platform status

Current support and validation scope, updated 2026-11-21. Other platform documents link here; dated validation records retain their original scope.

| Platform | Desktop status | Validation limits |
| --- | --- | --- |
| Windows x64 | Established desktop target; a portable ZIP and a per-user installer are available. | Windows CI checks run on every pull request; packaged releases are not signed yet. |
| macOS Apple Silicon | Current priority. Source startup and a local unsigned `.app` work on an Apple Silicon (M2) Mac; the Apple Silicon release is ad-hoc signed and the installed app updates itself from the signed update feed. | Local desktop acceptance continues in [MAC-PORT.md](MAC-PORT.md). No Developer ID and no notarization; the signed-feed update path is the supported Apple Silicon update path. |
| macOS Intel | Native packaging code accepts x64. | No Intel Mac desktop acceptance has been performed. |
| Linux | Portable backend and platform branches exist. CI is paused until Linux desktop work starts. | Desktop packaging, login interactions and end-user acceptance remain unverified. |

Server nodes are supported on Linux x64; other server architectures have not been verified.

## Checks and releases

The [CI workflow](../.github/workflows/ci.yml) runs Windows checks after a push to `main`. Pull requests and manual runs check both Windows and macOS. Feature-branch pushes do not start a second copy of the PR checks. Both platforms must pass; Linux checks are paused. CI does not infer which operating system a contributor used.

Both `npm test` and `npm run test:ci` limit file concurrency to two, and retained renderer smoke scripts run through the default suite. Platform skips are reported as skips.

CI success is evidence for those checks, not a desktop release certification. Windows review downloads are produced only by a manually requested workflow. Local Mac packages are unsigned test builds. No workflow here publishes a Release or merges a change.

See [Mac setup](MAC-PORT.md) for local use, [Windows releases](RELEASING-WINDOWS.md) for the shipped Windows update paths, [Mac releases](RELEASING-MAC.md) for the Mac release build, and [cross-platform notes](CROSS-PLATFORM.md) for deferred work.

## Keeping platform work apart

Windows, macOS and shared work land on one `main`. A Mac feature must leave Windows behaviour unchanged, and a Windows feature must leave macOS behaviour unchanged. Platform-specific behaviour belongs in a `src/server/platform/*` helper that takes a `Host` and is tested with [fake hosts](../tests/helpers/fake-host.ts); see the [Mac port rules](MAC-PORT.md#8-rules-for-future-windows-side-work).

### Path classes

[`scripts/platform-paths.mjs`](../scripts/platform-paths.mjs) assigns each changed path to the first matching class below (case-insensitive).

| Class | Paths | Must pass |
| --- | --- | --- |
| windows | `src/server/platform/powershell.ts`, `src/electron/windows-backend-guard.ts`, `src/electron/taskbar-identity.ts`, `src/server/sandbox/mxc-*`, `launchers/*.cmd`, `launchers/*.vbs`, `Start-PugPort.cmd`, `bin/*.cmd`, `Setup-Windows.ps1`, `scripts/create-windows-launcher.*`, `tests/windows-*.test.ts`, `tests/platform-windows-*.test.ts` | Windows |
| mac | `launchers/*macos*`, `scripts/*-mac-*`, `tests/*macos*.test.ts`, `**/*.plist` | macOS |
| posix | `src/server/platform/posix-*.ts`, `src/electron/posix-backend-guard.ts`, `tests/posix-*.test.ts` | macOS and Linux |
| linux | `launchers/*linux*` (no files yet) | Linux |
| platform-core | `src/server/platform/{host,dirs,executables,trash,protected-roots,terminal-path,service}.ts`, `tests/helpers/fake-host.ts` | Windows and macOS |
| docs-only | `docs/**` and `**/*.md`, except `docs/examples/**`, `docs/*.json`, `THIRD_PARTY_NOTICES.md` and files under `assets/`, `licenses/`, `src/` or `tests/` | Formatting and link checks |
| shared | Everything else | Windows and macOS |

A change must pass the checks of every class it touches; a rename counts both names. Classes are a minimum: `mxc-*`, `taskbar-identity.ts`, `platform-windows-pins.test.ts` and `posix-task-identity.test.ts` also load or run on the other system, and pull requests still run both platforms. While Linux checks are paused, a posix change needs macOS.

```bash
git -c core.quotePath=false diff --name-status main...HEAD | node scripts/platform-paths.mjs
```

It also accepts plain paths as arguments and prints `{ "classes", "checks", "files" }` as JSON.

### Guard test

[`tests/platform-branch-guard.test.ts`](../tests/platform-branch-guard.test.ts) counts lines in `src/**/*.{ts,tsx,mts,mjs}` outside `src/server/platform/` that use `process.platform`, `os.platform()`, a quoted `'win32'`, `'darwin'` or `'linux'`, a PowerShell program name, `%VARIABLE%` syntax, `APPDATA`, `LOCALAPPDATA` or `USERPROFILE`. Because Windows variable names ignore case, `env.appdata` and `%AppData%` count too. Comments do not count; strings do. The test documents the remaining choices.

It fails when a file has more hits than [the baseline](../tests/fixtures/platform-branch-baseline.json), or a new file has any, and names the lines: move that logic into a `src/server/platform/` helper. When counts drop it passes and prints the refresh command:

```bash
node scripts/platform-baseline.mjs --write
```

`--write` refuses increases; `--write --allow-increase` is only for an owner-approved exception. `node scripts/platform-baseline.mjs --check` runs the same comparison outside the test suite. The baseline holds 301 direct platform checks in 105 files.

### Branch names

Without an issue, name the branch after its class: `win/<slug>`, `mac/<slug>` or `shared/<slug>`. With an issue, `<who>/<issue>-<slug>` from [AGENTS.md](../AGENTS.md) still applies. Keep Windows-only and Mac-only work on separate branches.

