# 发布结果与延后发现

## npm 0.1.4 发布证据

- 包：`@pennixrv/fast-context-skill@0.1.4`。
- 源提交 `C`：`cbe88d1baafb31478b23af9e8a862539662316f1`。
- 证据提交 `E`：`46e3e3a1f0c34e5918cabe4454b03a2372115376`，直接父提交为 `C`，仅新增 `docs/releases/attestations/v0.1.4.json`。
- annotated tag：`v0.1.4`，peeled target 为 `E`。
- 受跟踪工件：`docs/releases/artifacts/v0.1.4.tgz`，SHA-256 为 `df05802d3a4652464390040b8495acada4198a184ad86917300f21e7201e5c1c`。
- 在 `arch-via-nas` 上使用临时 Node `26.5.1` / npm `12.0.1` 和已有 npm 身份运行仓库原生 `release:preflight`；未读取、复制或记录 token。
- GitHub Actions `Publish npm (manual)` run `31382072033` 的 `validate` 和 `publish` job 全部成功，包括 tag/evidence 验证、确定性 tarball 摘要、离线安装、测试、provenance、allowlist、registry 下载 SHA-256 和 `npm audit signatures`。

## 延后发现：tag 验证工作流浅克隆

`Validate Release Tag` run `31381919188` 在 `verify-tag.mjs` 失败。原因是 `.github/workflows/release-tag.yml` 中 `actions/checkout@v4` 未设置 `fetch-depth: 0`：Actions 只检出 peeled commit，未保留 annotated tag object，而验证器正确要求 `git cat-file -t v0.1.4` 为 `tag`。

交叉证据：同一 tag 在完整全新克隆中通过 `verify-tag.mjs`；`Publish npm (manual)` 使用 `fetch-depth: 0`，其 tag、evidence 及后续发布验证全部通过。当前发布 tag 已按不可变契约保持不动；此 workflow 修复不扩张到 Issue 045-050 实现中，后续应为 tag checkout 增加 `fetch-depth: 0` 并补充对应回归验证。
