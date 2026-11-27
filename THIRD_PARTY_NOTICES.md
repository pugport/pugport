# Third-party sources and license records

This file records dependencies, reference sources and attribution against pinned source snapshots. PugPort's own code is licensed under Apache-2.0; that does not change the licenses of third-party code. The locked dependencies and bundled notices for the current Windows release are listed in the [npm inventory](docs/DEPENDENCY-LICENSES.json) and the [npm supplement inventory](docs/NPM-LICENSE-SUPPLEMENTS.json); packaging checks the matching versions, notices and supplement hashes before and after each build. The Magpie gateway has been removed from installation, runtime integration and release packages; the sources referenced by the independent implementation and the original MIT license are still kept. These checks are not a legal guarantee about every upstream ownership question or commercial use.

## Runtime components in use

| Component | Current version | License / attribution | Use in this project and original notices |
| --- | --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi/tree/v1.6.0) / `@earendil-works/pi-coding-agent` | 1.6.0 | MIT; Copyright (c) 2025 Mario Zechner | Separate child process and RPC for API tasks; Pi's MIT text is kept in [licenses/Pi-MIT.txt](licenses/Pi-MIT.txt) and below in this file |
| `@earendil-works/pi-tui` (installed with Pi) and its dependencies `marked`, `get-east-asian-width` | 1.6.0 / 18.0.11 / 1.6.0 | pi-tui: MIT, Copyright (c) 2025 Mario Zechner (see Pi's MIT text below); marked: MIT, Copyright (c) 2018+ MarkedJS, 2011-2018 Christopher Jeffrey, plus the BSD notice of John Gruber, the original Markdown author; get-east-asian-width: MIT, Copyright (c) Sindre Sorhus | Interface library for the `pugport` terminal command, bundled into `dist/cli/pugport.js` at build time. The layout, key handling and display of terminal chats follow Pi's interactive mode; PugPort's implementation is written independently. Original licenses: `node_modules/marked/LICENSE` and `node_modules/get-east-asian-width/license` |
| `marked-cjk-friendly` (installed with Pi TUI) | 0.1.2 | MIT; Copyright (c) 2024 Tatsunori Uchino, and authors and contributors of original packages | Better CJK Markdown rendering; original license at `node_modules/marked-cjk-friendly/LICENSE` |
| [Orca](https://github.com/stablyai/orca) | Source snapshot 2026-10 | MIT; Copyright (c) 2026 Lovecast Inc. | Reference for, and partial port of, the web element picker rules and the image scaling budget for annotations (`src/electron/page-markup.ts`, `src/ui/markup-compose.ts`); full license text in [licenses/Orca-MIT.txt](licenses/Orca-MIT.txt) |
| React / React DOM | 19.3.0 | MIT; Meta Platforms, Inc. and affiliates | UI; `node_modules/react/LICENSE`, `node_modules/react-dom/LICENSE` |
| Express | 5.2.1 | MIT; original author attribution in LICENSE | Local server; `node_modules/express/LICENSE` |
| `@microsoft/mxc-sdk` | 1.0.0 | MIT; Copyright (c) Microsoft Corporation | Windows sandbox SDK, loaded on demand; `node_modules/@microsoft/mxc-sdk/LICENSE.md` is kept |
| `jsonc-parser` | 3.3.1 | MIT; Copyright (c) Microsoft | Parsing and in-place editing of MCP JSONC configuration; `node_modules/jsonc-parser/LICENSE.md` is kept; no transitive dependencies |
| MXC's transitive dependencies `koffi` / `@koromix/koffi-*`, `node-pty`, `node-addon-api`, `semver` | 3.3.3 / 3.3.3, 1.1.0, 7.1.1, 7.8.5 | Koffi, node-pty, node-addon-api: MIT; semver: ISC | Original attribution and licenses in each package's LICENSE. The Koffi platform packages do not ship the full text, so the original license of the same Koffi version is used: [licenses/koffi-MIT.txt](licenses/koffi-MIT.txt), Copyright (C) 2026 Niels Martignène. All 20 optional platform packages are in the npm license inventory; the Windows x64 package is the one currently installed. semver reuses the existing locked version |
| Zod | 4.6.7 | MIT; Copyright (c) 2025 Colin McDonnell | Interface validation; `node_modules/zod/LICENSE` |
| [ADM-ZIP](https://github.com/cthackers/adm-zip) / `adm-zip` | 0.6.1 | MIT; Copyright (c) 2012 Another-D-Mention Software and other contributors | The Microsoft Office connector reads, updates and creates DOCX/PPTX/XLSX ZIP packages in memory. PugPort also limits package size, expanded size, entry count and compression ratio, and never extracts entries to the file system. Release packages keep `node_modules/adm-zip/LICENSE` |
| [xmldom](https://github.com/xmldom/xmldom) / `@xmldom/xmldom` | 0.9.12 | MIT; Copyright 2019 - present Christopher J. Brody and other contributors; Copyright 2012 - 2017 @jindw and other contributors | The Microsoft Office connector parses and serializes Office XML and keeps unedited document structure; PugPort rejects DTDs and entities and limits XML size and depth. Release packages keep the full original attribution and `node_modules/@xmldom/xmldom/LICENSE` |
| [MiniSearch](https://github.com/lucaong/minisearch) / `minisearch` | 7.2.0 | MIT; Copyright 2022 Luca Ongaro | Chunked full-text index and BM25 ranking for local history. The license as originally published is saved unchanged in [licenses/MiniSearch-MIT.txt](licenses/MiniSearch-MIT.txt), and release packages also keep `node_modules/minisearch/LICENSE.txt`. Chinese word segmentation, project/time isolation, path checks and prompt injection are implemented by PugPort |
| Lucide React | 1.50.0 | ISC; icons derived from Feather are additionally MIT | Icons; full list and both licenses in `node_modules/lucide-react/LICENSE` |
| Electron | 44.9.1 | Electron itself is MIT; bundled components carry their own notices | Desktop shell; `node_modules/electron/LICENSE` and the notices inside the actual Electron distribution |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) / `sherpa-onnx-node` | 1.13.8 | Apache-2.0; Copyright (c) Xiaomi Corporation and contributors | Local speech recognition engine for voice input (Node.js native module, includes onnxruntime) |
| [SenseVoiceSmall](https://github.com/FunAudioLLM/SenseVoice) (sherpa-onnx int8 conversion, 2024-07-17) | 2024-07-17 | [FunASR model license](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE); source and authors: the FunAudioLLM team at Alibaba Tongyi Lab; the model name SenseVoice is kept as the license requires | Speech recognition model for voice input (Chinese, English, Japanese, Korean, Cantonese). `scripts/setup-voice.mjs` downloads it to `.runtime/voice/` against a pinned SHA-256; audio is processed only on this computer |
| [Chinese-CLIP](https://github.com/OFA-Sys/Chinese-CLIP) ViT-B/16 ([Xenova ONNX int8 conversion](https://huggingface.co/Xenova/chinese-clip-vit-base-patch16), revision `f26904860903e70e050b8f48255e5f48401816e9`) | — | MIT; Copyright (c) 2012-2022 OFA-Sys Team | Local model for image search (similar content, search by description). `scripts/setup-image-search.mjs` downloads it from Hugging Face (or a mirror) to `.runtime/image-search/` against a pinned SHA-256; images are processed only on this computer |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv4 text detection and recognition models ([RapidOCR](https://github.com/RapidAI/RapidOCR) ONNX conversion, revision `1cfba2e90fc938db55889873735088de210cc173`) and the character list `ppocr_keys_v1.txt` (commit `338ba3ee4a0208cee354cd3b7d2c93b320e0ea54`) | PP-OCRv4 | Apache-2.0; Copyright PaddlePaddle Authors; RapidOCR: Apache-2.0 | Reads text in screenshots and photos of documents, so images can be found by the words in them. `scripts/setup-image-search.mjs` downloads them to `.runtime/image-search/ocr/` against a pinned SHA-256; processing stays on this computer |
| [bge-m3](https://huggingface.co/BAAI/bge-m3) ([Xenova ONNX int8 conversion](https://huggingface.co/Xenova/bge-m3), revision `4de13258303883538bd53b696b452bf8099f0858`) | — | MIT; Copyright (c) BAAI (Beijing Academy of Artificial Intelligence) | Turns past conversations into vectors for search by meaning. `scripts/setup-memory-search.mjs` downloads it to `.runtime/memory-search/` against a pinned SHA-256; conversation content is processed only on this computer |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) / `onnxruntime-node` | 1.30.0 | MIT; Copyright (c) Microsoft Corporation | Runs the image search models locally (packaging keeps only the Windows x64 binaries) |
| [sharp](https://github.com/lovell/sharp) / `@img/sharp` platform packages (Windows x64, macOS arm64/x64, including [libvips](https://github.com/libvips/libvips)) | 0.35.5 | sharp: Apache-2.0, Copyright Lovell Fuller and contributors; libvips and its prebuilt dependencies: LGPL-3.0-or-later and others (the original component license table for macOS 1.3.4 and the full LGPL/GPL texts are in `licenses/npm/sharp-libvips-1.3.4`) | Decodes JPG, PNG, WebP, GIF, TIFF and AVIF for image search. libvips ships as a dynamic library and can be replaced under the LGPL |
| [OpenCV](https://opencv.org) / `@techstark/opencv-js` | 4.12.0-release.1 | Apache-2.0; Copyright OpenCV team and contributors | ORB feature matching and RANSAC verification running in WebAssembly, used to find the original image from a cropped screenshot |
| Node.js / built-in SQLite | Node.js 24+ | As stated in the notices shipped with the Node distribution in use | Local backend and `node:sqlite`; `.runtime/node.exe` is a local copy of the Node runtime, not PugPort's own code |

Codex, Claude Code and Grok are installed separately by the user; PugPort calls them as processes over their public local protocols. Their installers, account access and model services remain under their own licenses and terms of service. Calling a CLI does not make its implementation, model weights, trademarks or subscription rights part of this project's Apache-2.0 assets.

### Magpie design reference and earlier integration

Earlier versions distributed the [official Magpie Windows CLI and desktop app](https://github.com/yetone/magpie-releases) and verified their pinned versions, SHA-256 hashes and third-party materials. The gateway downloader and binary packaging have since been removed, and the Go/Wails notices and the original inventory used only by that gateway have been removed from the source tree as well. Earlier versions recorded these materials; they are no longer part of this source tree. This cleanup does not delete a user's existing `.runtime/magpie/` cache, account configuration, sessions or usage records; those local files never go into the current release package.

Account health, limit cooldowns and the related protocol research keep their attribution to [yetone/magpie](https://github.com/yetone/magpie); the pinned snapshot and methods are noted in the source files. These features are implemented independently by PugPort and do not need Magpie to run. The full upstream MIT license is saved as [licenses/Magpie-MIT.txt](licenses/Magpie-MIT.txt), Copyright (c) 2026 yetone, taken from pinned commit [c9b7f95f904bc972bef4d7bdb382633b649bc695](https://github.com/yetone/magpie/blob/c9b7f95f904bc972bef4d7bdb382633b649bc695/LICENSE). That license grants no rights to third-party accounts, trademarks or model services.

### Hermes Desktop store layout

The grouped cards and compact filter layout of the Mods Store are adapted from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/290080e19e8e143d35f67427e89aed662161faf8), pinned commit `290080e19e8e143d35f67427e89aed662161faf8`, Copyright (c) 2025 Nous Research, MIT. The specific sources are `apps/desktop/src/app/capabilities/catalog/catalog.css`, `apps/desktop/src/app/capabilities/catalog/catalog-discovery.css` and `apps/desktop/src/app/capabilities/ui/catalog-surface.tsx`; the adapted code is in `src/ui/StorePage.tsx` and `src/ui/StorePage.css`. The full upstream license is saved unchanged as [licenses/Hermes-MIT.txt](licenses/Hermes-MIT.txt) and kept with release materials. The adaptation covers presentation only and includes no Hermes brand images, plugin catalog, download service, accounts or runtime.

## Archived experiments

DSH 0.1.5-rc.3 was removed from the dependencies and desktop release package as of Agent Studio 0.5.0 (the former brand). PugPort 0.0.1 then moved the earlier bridge source, package lock and original MIT license (`DSH-LICENSE`, Copyright (c) 2026 DeepSeek) to a DSH archive outside the project; that archive is not distributed with the public source. pi2dsh, dsh-pi-tui and their source archives, manifests and licenses were moved to the same external archive. The files were archived rather than permanently deleted. They take no part in installation, builds or distribution.

Jev (TypeSafe): when the Routing advice setting is set to `jev`, PugPort sends the current request to `api.typesafe.ai/v1/systemone` with the user's own Jev key for a task-difficulty judgment (`src/server/task-judgment.ts`); other modes use local rules. The client follows TypeSafe's public HTTP contract. The official `@typesafe-ai/sdk` 0.6.0 is MIT-licensed, but this project neither installs nor distributes it, and the SDK license does not grant any right to the hosted service.

## Build and development dependencies

### Desktop interactive terminal

`@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 are MIT licensed and handle terminal rendering and size fitting; the full original copyright and license texts are in [licenses/xterm-MIT.txt](licenses/xterm-MIT.txt) and [licenses/xterm-addon-fit-MIT.txt](licenses/xterm-addon-fit-MIT.txt). `node-pty` 1.1.0 is now a direct runtime dependency that provides the local pseudo-terminal; its full MIT license and the notices for bundled components are kept in the release package at `node_modules/node-pty/LICENSE`. Versions, npm sources and the license files inside each package are also recorded in `docs/DEPENDENCY-LICENSES.json`. The implementation copies no Orca source code.

The optional configuration generated by the Chrome panel references the official `chrome-devtools-mcp` 1.12.0 (Apache-2.0), but PugPort does not install or bundle that package; the user imports and authorizes it separately through extension management.

| Component | Pinned version | License declared by the npm package |
| --- | --- | --- |
| TypeScript | 7.0.2 | Apache-2.0; `node_modules/typescript/LICENSE` and `NOTICE.txt` |
| `@electron/packager` | 20.3.0 | BSD-2-Clause; `node_modules/@electron/packager/LICENSE` |
| Vite / `@vitejs/plugin-react` | 8.3.1 / 6.1.1 | MIT |
| esbuild | 0.28.2 | MIT |
| tsx | 4.23.15 | MIT |
| `@types/express` / `@types/node` | 5.0.6 / 26.6.3 | MIT |
| `@types/react` / `@types/react-dom` | 19.3.0 / 19.3.0 | MIT |

These are direct dependencies only; they do not justify describing the whole npm tree as "all MIT". Build tools may generate or include their own third-party notices, and those must be kept as well.

## Downloaded source that is not active as a runtime dependency

The table lists the pinned snapshots that are kept or have been moved out of the project. The downloader does not run their install scripts, Git hooks or project code. The current packaging scripts exclude all of `vendor/`, and the external archive is not in the product directory. "MIT" in these records is the repository's top-level license and does not replace notices on other files in a snapshot.

| Source | Pinned commit | Local directory | Purpose |
| --- | --- | --- | --- |
| [flaviusapop/jev-router](https://github.com/flaviusapop/jev-router/tree/0ada4f883127ea9e5cd0e00521b442ce804b17c9) | `0ada4f883127ea9e5cd0e00521b442ce804b17c9` | `vendor/jev-router-0ada4f883127` | Earlier reference for CLI routing, cross-platform launching and offline tests; not a runtime integration |
| [nidhi-singh02/agent-router](https://github.com/nidhi-singh02/agent-router/tree/b448dc1fbc5997f11caf317087b5b63c6f50748a) | `b448dc1fbc5997f11caf317087b5b63c6f50748a` | `vendor/agent-router-b448dc1fbc59` | Reference for quota routing and native CLI selection |
| [AdamFrisby/CodeyBox](https://github.com/AdamFrisby/CodeyBox/tree/d7a9c4fb1221a58ee0026cafbe33d74ec0156008) | `d7a9c4fb1221a58ee0026cafbe33d74ec0156008` | `vendor/CodeyBox-d7a9c4fb1221` | Reference for quota pools and work scheduling |
| [weijiafu14/pi2dsh](https://github.com/weijiafu14/pi2dsh/tree/b63c8c232bdb4c6f213540f549b56649dad7a12a) | `b63c8c232bdb4c6f213540f549b56649dad7a12a` | External archive (not distributed with the public source) | Earlier reference for a Pi extension compatibility layer; removed from the product |
| [XMoon/dsh-pi-tui](https://github.com/XMoon/dsh-pi-tui/tree/0d307050eb59955ae4e53694f4d5d3a3301509ac) | `0d307050eb59955ae4e53694f4d5d3a3301509ac` | External archive (not distributed with the public source) | Earlier DSH/Pi terminal reference; removed from the product |

The top-level LICENSE of all five snapshots is MIT. The jev-router `NOTICE` is kept specifically: it states that the project derives from [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) and keeps `Copyright (c) 2026 Jev Router contributors`. When copying related code selectively, do not keep only the later fork's name and drop that origin.

The original download paths and sources were recorded locally when the snapshots were taken. The manifests and original archives of the three references still kept are in `vendor/.manifests/` and `vendor/.archives/`; the files for the two retired references were moved to the external archive. This information confirms the exact version of each reference; it does not mean compatibility testing, installation or runtime use has been done.

## Pi 1.6.0 MIT license text

The current 1.6.0 npm package metadata declares MIT, but the package roots have no LICENSE file. [licenses/Pi-MIT.txt](licenses/Pi-MIT.txt) keeps the unchanged [LICENSE at the official v1.6.0 tag](https://github.com/earendil-works/pi/blob/faac585884ae2c013a6b1400f3e9e77f10b34bac/LICENSE) (commit `faac585884ae2c013a6b1400f3e9e77f10b34bac`), original bytes SHA-256 `0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48`; the v1.2.0 and v1.4.0 tags carry the same bytes. The same text is repeated below. It is the only LICENSE in that repository and covers the Pi code in use and the subpackages published from it that declare MIT: `@earendil-works/pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`, `pi-schema`, `pi-telemetry` and `pi-tui`. It does not replace the licenses of Pi's own transitive dependencies; the MCP SDK license bundled with `pi-mcp` and the TypeBox license bundled with `pi-schema` are in each package's `THIRD_PARTY_NOTICES/` directory.

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Grok zero-usage billing check reference

The protobuf field mapping and implicit-zero check in `src/server/grok-billing-supplement.ts` follow [steipete/CodexBar](https://github.com/steipete/CodexBar/tree/ad81eeded84ea2ed7e930c291c5168aa2f59070d), pinned commit `ad81eeded84ea2ed7e930c291c5168aa2f59070d`, specifically `Sources/CodexBarCore/Providers/Grok/GrokWebBillingFetcher.swift` and `Tests/CodexBarTests/GrokZeroUsageTests.swift`. PugPort uses an independent TypeScript implementation that also requires a match with the current CLI billing period and account identity; it does not copy CodexBar's browser sign-in or credential refresh logic. The original MIT copyright and full license are saved in [licenses/CodexBar-MIT.txt](licenses/CodexBar-MIT.txt), Copyright (c) 2026 Peter Steinberger.

## Transitive dependency notices added in 0.0.7

| Component | Bundled license | Source and scope |
| --- | --- | --- |
| `standardwebhooks` 1.3.0 | [StandardWebhooks-MIT.txt](licenses/StandardWebhooks-MIT.txt); Copyright (c) 2023 Svix | [libraries/LICENSE](https://github.com/standard-webhooks/standard-webhooks/blob/daee8284cfe9d4e435ec16e3e68a8f30084d6aaf/libraries/LICENSE) from the npm-published source at gitHead `daee8284cfe9d4e435ec16e3e68a8f30084d6aaf`, original bytes SHA-256 `5ec8c7b26b64d881a6706617bed25c049f97f2f35de034c756de8546fd6dbe27`. This library is under MIT; the Apache license at that repository's root does not apply to it. |
| AWS SDK for JavaScript v3 components | [AWS-SDK-JS-Apache-2.0.txt](licenses/AWS-SDK-JS-Apache-2.0.txt); Copyright 2018 Amazon.com, Inc. or its affiliates | Keeps the full LICENSE of the installed `@aws-sdk/core`, checked against the [official AWS LICENSE](https://github.com/aws/aws-sdk-js-v3/blob/main/LICENSE). It also covers `@aws-sdk/credential-provider-http` 3.972.72, `credential-provider-login` 3.972.77 and `nested-clients` 3.997.44, which have no separate LICENSE file and whose metadata declares the same license; notices shipped with other packages are kept as usual. |
| esbuild / `@esbuild/win32-x64` 0.28.2 | [esbuild-MIT.txt](licenses/esbuild-MIT.txt); Copyright (c) 2020 Evan Wallace | Saved unchanged from the `LICENSE.md` of the installed esbuild of the same version; [official license for that version](https://github.com/evanw/esbuild/blob/v0.28.2/LICENSE.md). |

## Release materials completed in 0.0.8

The original published README of `data-uri-to-buffer` 4.0.1 contains the full MIT text, which has been extracted unchanged. The original releases of `proxy-agent-negotiate`, `err-code` and `@electron-internal/extract-zip` declare a license but include no full text; the exact published declaration, author information and the official SPDX standard text are now kept and clearly marked as release supplements, not presented as an upstream LICENSE. extract-zip 1.0.5 is recorded under its original BSD-2-Clause license, without applying the later MIT change. A pinned source notice for the Rolldown binding was also added. [Materials and sources](licenses/npm/README.md)

In that earlier version, the Magpie supplement covered 51 components and 150 notices across two Windows binaries. The current desktop package no longer distributes those programs, and their dedicated third-party dependency materials have also been removed from the source tree.

All notices and original author attributions must be kept with every release they apply to. New or upgraded dependencies require regenerating the inventory and passing the packaging gate; license obligations are never removed by deleting Git history or renaming.

## Subtask orchestration design reference

The subtask entry point in 0.0.16 follows the role delegation, parent-child linking and completion reporting design of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents/tree/c100577ebf7393a11d098ad9810ec6c269dcfc30). It is implemented as independent code on PugPort's own queue; the plugin is not installed and its terminal launcher was not copied, and PugPort does not claim drop-in compatibility with the plugin. The upstream MIT notice is saved separately in `licenses/pi-interactive-subagents/LICENSE`, Copyright (c) 2026 HazAT.

## skill-doctor

The bundled skill [skill-doctor](https://github.com/warpdotdev/common-skills) comes from warpdotdev/common-skills (`.agents/skills/skill-doctor`), Copyright (c) 2026 Denver Technologies, Inc., MIT. The full original license is in [licenses/skill-doctor-MIT.txt](licenses/skill-doctor-MIT.txt) and `assets/skills/skill-doctor/LICENSE`. PugPort's changes: removed the Warp Factories promotion and the Warp logo in reports, does not ship the upstream `pierre-diffs.js` (differences in reports are shown as plain text instead), and added a `pugport` collector that reads PugPort's own conversation records. The text attribution is kept.
