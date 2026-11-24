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
