# Windows releases

The Windows installer uses the existing lightweight desktop package and electron-builder NSIS. Its permanent
application ID is `ComboRunner.App`. Installation is per user, and uninstall preserves
`%APPDATA%\ComboRunner\data`.

## Download paths

Windows has a per-user installer and a portable ZIP today.

- The per-user installer ships from the release build: `npm run release:win` packages the unpacked `release/PugPort-win32-x64`
  desktop package into an electron-builder NSIS installer, `PugPort-Setup-<version>.exe`, with per-user installation
  (`perMachine: false`), one-click install, no app-data removal on uninstall and run-after-finish. The uninstall
  preserves `%APPDATA%\ComboRunner\data`.
- The portable ZIP is a review-build artifact: the CI workflow creates `PugPort-<version>-windows-x64-<shortCommit>.zip`
  (a `Compress-Archive` of the unpacked `release/PugPort-win32-x64` folder), adds `SHA256SUMS.txt` and a package
  inventory, and uploads it as a 14-day Actions artifact for testers. It is not a published Release and not the in-app
  updater. Extract the complete folder and run `PugPort.exe`; do not copy only the executable.

Installed Windows copies read the update feed at `https://download.pugport.com/windows`.

## Build locally

1. On Windows, update the version with `npm run version:patch` when preparing a new release.
2. Run the required targeted tests, type check, translation check and `npm run verify:licenses`. Commit the release
   changes; the working tree must be clean.
3. Run `npm run release:win`. This builds the app, packages it, creates an unsigned installer and verifies its
   version, SHA-512 and size against `latest.yml`.
4. Find the installer, differential `.blockmap` and `latest.yml` in `release/installer/<version>/`.

Building never uploads. Do not launch an installer or packaged app against a development profile for validation.

## Publish only when authorized

Once, have the infrastructure owner configure the `pugport-downloads` R2 bucket and the custom download domain.
Create an R2 API token with **Object Read & Write**, scoped to that bucket only. Keep its values in the release
shell environment, never in Git, command arguments or logs:

- `PUGPORT_R2_ACCOUNT_ID`: account ID.
- `PUGPORT_R2_ACCESS_KEY_ID`: token access key ID.
- `PUGPORT_R2_SECRET_ACCESS_KEY`: token secret access key.
- Optional `PUGPORT_R2_BUCKET`: defaults to `pugport-downloads`.

Use `npm run release:win -- --upload` only with explicit publication authorization. The script refuses a version
that is not newer than remote `windows/latest.yml`. It uploads the versioned installer and blockmap, copies the
installer to `windows/PugPort-Setup.exe`, and publishes `windows/latest.yml` last. The manifest and stable installer
use `Cache-Control: no-cache`. Installed Windows copies read `https://download.pugport.com/windows`.

## Stop a bad release

With explicit publication authorization, re-upload the previous known-good `windows/latest.yml` to stop more
clients discovering the bad release. Restore the stable download installer if needed. Installed copies do not
downgrade, and copies that already downloaded an update may still install it. Ship the fix as a new patch version.

## Signing

Signing is disabled with `win.signExecutable: false` in `electron-builder.yml`; no `publisherName` is configured.
The marked configuration placeholder is reserved for a separately authorized Azure Artifact Signing setup.
Until then Windows may show an unsigned-publisher or SmartScreen warning.
