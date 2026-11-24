# Mac releases

Mac releases are Apple Silicon (arm64) desktop builds made by `scripts/release-mac.mjs` on a Mac. There is no DMG; a
release ships an app bundle plus a signed update feed.

## What the release script builds

`npm run release:mac` builds, ad-hoc signs, zips and signs the update manifest for one Mac release, and uploads only
with `--upload`.

1. Requires a Mac, an architecture of `arm64` or `x64`, a clean working tree, a release from the default branch (or with
   `--allow-branch`), a signing key that loads, and `npm run typecheck` before anything changes.
2. Bumps the version, then runs the build and desktop packaging.
3. Produces the app at `release/PugPort-darwin-<arch>/PugPort.app` for the building Mac's architecture; Apple Silicon
   builds use `arm64`, Intel builds use `x64`.
4. Ad-hoc signs the app with `codesign --force --deep --sign -` and verifies it with `codesign --verify --deep --strict`.
   There is no Developer ID and no notarization; the automatic update still works through the signed feed.
5. Archives the bundle with `ditto -c -k --keepParent` into `release/mac/<arch>/PugPort-<version>-mac-<arch>.zip`.
6. Writes `release/mac/<arch>/latest.json` (which contains the version, the archive URL, its sha256 and its size) and
   `latest.json.sig`, the Ed25519 detached signature over the exact `latest.json` bytes, and verifies both against the
   release public key in `src/shared/app-update.ts`. A release uploads the archive, then the signature, then the
   manifest, and publishes the manifest last.

The signing key comes from `PUGPORT_UPDATE_SIGNING_KEY` or defaults to
`~/.pugport-release/update-signing-key.pem`; it must be an Ed25519 private key that derives the public key the app
trusts.

The script warns while building when the archive is above the 300 MiB Wrangler upload limit, and refuses the upload
(`--upload`) above it; it refuses to run outside a Mac.

## Local build

`npm run package:desktop` after a successful build produces an unsigned local validation bundle; see
[Mac setup](MAC-PORT.md).

## Update path

The installed app reads the release feed at `https://download.pugport.com` (`mac/<arch>/latest.json` plus its
signature), verifies the Ed25519 signature over the manifest bytes, then downloads the archive and verifies its sha256,
and installs only a strictly newer version. The user sees the offered update; installing makes the app quit normally
(running work asks first) and swap the bundle before it restarts.

Apple Silicon is the supported Mac update path; no Intel desktop acceptance has been performed. See
[platform status](PLATFORMS.md) for the current support scope.
