# scripts/

Most contributors only need the npm scripts (`npm run build`, `npm test`, …). The files here are grouped by purpose below.

⚠️ = sends **real model requests** with your logged-in accounts and consumes quota. Read the script first and never add it to CI.

## Build and release

| Script | What it does |
| --- | --- |
| `build.mjs` | Builds the UI (Vite) and bundles server + Electron (esbuild). `npm run build` |
| `package.mjs` | Packages the Windows desktop app into `release/`. `npm run package:desktop` |
| `release-mac.mjs` | Builds, ad-hoc signs and zips the Mac app and writes the signed update manifest into `release/mac/<arch>/`; maintainer-only; uploads only with `--upload`. `npm run release:mac` |
| `verify-lite-package.mjs` | Checks an existing default Windows package for unexpected local data, optional models and other-platform inference libraries; emits a versioned file inventory. Never starts the app. |
| `version.mjs` | Bumps the version in package.json, lockfile and `src/shared/identity.ts`. `npm run version:patch` |
| `prepare-source.mjs` | Builds an inspectable source export (no git, no upload) |
| `doctor.mjs` | Reads environment diagnostics and fails when required Node, Electron or build files are missing. Does not run tests or repair data. `npm run doctor` |
| `create-windows-launcher.mjs` | Generates the portable hidden source launcher at `.data/launchers/start-pugport.vbs`; does not launch the app or modify desktop shortcuts |

Default packaging excludes downloaded local components. `node scripts/package.mjs --with-local-components` explicitly includes available local resources for an offline build. The GitHub **PugPort checks** workflow runs ordinary checks on push/PR; **Run workflow** additionally produces a default Windows ZIP, SHA256 and inventory as a 14-day review artifact. It does not publish a Release.

## Licenses (`npm run verify:licenses`)

| Script | What it does |
| --- | --- |
| `audit-dependency-licenses.mjs` | Regenerates/checks `docs/DEPENDENCY-LICENSES.json` from package metadata |
| `refresh-npm-license-supplements.mjs` | Fetches license texts missing from npm packages (pinned upstream commits) |
| `verify-license-bundle.mjs` | Offline gate: checks the exact license material shipped in source/package |
| `fetch-references.mjs` | Downloads pinned upstream source snapshots into `vendor/` for reading only |

## Platform boundaries ([PLATFORMS.md](../docs/PLATFORMS.md#keeping-platform-work-apart))

| Script | What it does |
| --- | --- |
| `platform-baseline.mjs` | `--check` compares direct platform checks in `src/` outside `src/server/platform/` with `tests/fixtures/platform-branch-baseline.json`; `--write` lowers the baseline after checks were removed |
| `platform-paths.mjs` | Prints the platform classes and required OS checks for changed paths from stdin or arguments |

## Smoke tests with fixtures (no accounts, no model requests)

| Script | What it does |
| --- | --- |
| `smoke-core-ui.cjs`, `smoke-usage-ui.cjs` | Render the UI against a fixture server in hidden Electron windows |
| `smoke-composer.cjs` | Native dropdown theme contrast, Enter/Shift+Enter, IME guards and typing with 3,000 fixture history messages |
| `smoke-attachments-ui.cjs` | Real drag/paste/file-picker events against a fixture workspace |
| `smoke-queue.mjs`, `smoke-queue-ui.cjs` | Production HTTP/storage queue in an isolated data dir, all executors disabled |
| `smoke-desktop.cjs`, `smoke-single-instance.cjs` | Electron window, tray, IPC and single-instance behavior with temp profiles |
| `smoke-package.mjs`, `smoke-packaged.ts` | Launch the packaged app with an empty isolated database |

`smoke-composer.cjs` captures screenshots by default. If Electron cannot capture a hidden surface, set
`COMBORUNNER_COMPOSER_SMOKE_SCREENSHOTS=0` to run only style and input checks. The result explicitly records
`screenshotsSkipped`; it does not count as a successful pixel capture test.

Hidden Electron fixtures under `tests/` are registered in `tests/renderer-smoke.test.ts` and run serially within
both `npm test` and `npm run test:ci`. The registry rejects an unregistered top-level `.cjs` test.
For example, `conversation-queue-renderer-smoke.cjs`
checks queue controls and drag ordering, `workspace-side-chat-renderer-smoke.cjs` checks selection quotes,
independent side chat and its layout, and `reasoning-stream-renderer-smoke.cjs` checks scroll following.
`empty-composer-renderer-smoke.cjs` checks empty-Enter steering, queue order, duplicate protection,
composition keys, pending reorder and conversation switching during a held receipt.
Run one independently with `node tests/<filename>` (or `.runtime/node.exe` on Windows). They use isolated profiles and mocked APIs;
they do not launch account CLIs or send model requests.

## Live checks ⚠️

| Script | What it does |
| --- | --- |
| `smoke-core-connections.mjs` ⚠️ | One connection test per configured executor (`--live`) |
| `smoke-queue-live.mjs` ⚠️ | One read-only native Codex request through the real queue |
| `smoke-workspace.mjs` ⚠️ | A few small real tasks through the workspace |
| `smoke-one-for-all.ts` ⚠️ | One live read-only native Codex request through the workspace, with an explicit model and effort |
| `verify-codex-accounts.ts`, `verify-grok-accounts.ts` ⚠️ | Two-account relay validation |
| `verify-native-cli.ts`, `diagnose-native-cli.ts` | Probe installed CLIs (discovery and quota; may start the CLIs) |

## Data tools (local only)

| Script | What it does |
| --- | --- |
| `sync-grok-history.ts` | Incremental Grok history sync into one conversation; source archive and DB backup before changes |
| `sync-local-memory.ts` | Exports project/conversation history and handoffs, optionally `--all`; no model requests |
| `import-grok-history.ts`, `merge-grok-history.ts` | Compatibility entry points to the incremental sync service |
