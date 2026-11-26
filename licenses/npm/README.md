# npm 发行许可补充

这些材料补齐 0.0.7 核查发现的 5 个具体包版本缺项。它们不改变依赖本身的许可，也不宣称 ComboRunner 拥有依赖的著作权。

| 包 | 材料和依据 |
| --- | --- |
| data-uri-to-buffer 4.0.1（运行依赖） | 准确 npm 发布包的 README 已有完整 MIT 条款和 `Copyright (c) 2014 Nathan Rajlich`。原样保留 README，并逐字提取许可段。 |
| proxy-agent-negotiate 1.1.0（运行依赖） | 准确发布包明确声明 MIT 和作者 Nathan Rajlich，但没有独立许可全文。保留原始 package.json、固定发布源码及 npm provenance 陈述，并附 SPDX 官方 MIT 标准全文；没有冒充上游原 LICENSE，也没有编造版权年份。 |
| @electron-internal/extract-zip 1.0.5（开发依赖） | 准确发布包与 README 明确声明 BSD-2-Clause，但缺全文。保留原始声明及 SPDX 官方 BSD-2-Clause 标准全文。上游紧邻后续提交只更改许可材料，将作品许可为 MIT；该原始 MIT 和变更记录也保留为来源证据，但这里不把锁定版本的 BSD 字段偷偷改成 MIT。 |
| err-code 2.0.3（开发依赖） | 准确发布包声明 MIT、作者 IndigoUnited，README 明确链接 MIT 授权；附完整 SPDX MIT 标准全文及原始声明，不添加不存在的上游版权年份。 |
| @rolldown/binding-win32-x64-msvc 1.2.19（开发依赖） | 按 npm 发布 provenance 指向的固定 commit 保存原始 LICENSE 和 THIRD-PARTY-LICENSE，包括 VoidZero、Rollup、esbuild 的声明。 |

**标准文本不是伪造的上游原文。** `*-standard.txt` 来自 SPDX 官方 license-list-data v3.26.0，模板中的占位符原样保存；具体包身份、作者元数据、授权名称来自各目录的 `upstream-package.json`、原始 README 和 `ATTRIBUTION.md`。未找到的上游版权通知不会凭空补写。原文与本项目编写的说明分开放置。

每个包的 tarball 已按 `package-lock.json` 的 SHA-512 校验。`docs/NPM-LICENSE-SUPPLEMENTS.json` 保存许可证、来源证据、归属说明的 SHA-256，以及来源 URL、包版本、tarball SHA-256、源码 commit。provenance 保存的是公开 SLSA 陈述和其中的源码 commit，本脚本没有声称独立验证 Sigstore 签名。

在项目根目录运行：

```powershell
.runtime/node.exe scripts/audit-dependency-licenses.mjs --check
```

此命令离线检查补充文件 SHA-256、实际安装版本与锁文件一致性，更新完整 npm 清单，并对已安装生产依赖仍无文本的情况返回失败。它只读取包与许可文件，不读取账号。需要重新下载上述固定来源时运行 `scripts/refresh-npm-license-supplements.mjs`；刷新脚本只访问公共源码和 npm，并重新核对 tarball SHA-512。

本轮结果：418 个锁文件包路径中，本机安装 324 项（227 项生产、97 项开发）。5 个已知缺项均补齐可追溯材料，已安装包根许可证或已验证补充文本缺项为 0。其余 Pi、AWS、standardwebhooks、esbuild 补充继续由原清单映射。

范围：这消除了已知 npm 包根许可全文材料缺项。它不是所有原生二进制内部组件的法律认证；Magpie、Electron/Chromium 等运行二进制另按对应清单处理，开发用 Rust 二进制也不因此宣称已完成内部 crate 的全量再分发审查。上述开发依赖没有进入 ComboRunner Windows 运行包。
