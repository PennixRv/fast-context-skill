# v0.1.5 发布结果

## 证据链

- 包：`@pennixrv/fast-context-skill@0.1.5`。
- 源码提交：`ee37829f03686d2a7430de213913f41b46083c51`，实现受控 Devin 发现、公开远端错误分类、终结 answer-only 轮及回归测试。
- 首次工件提交 `e344f5a` 在本机 `Node 26.6.0/npm 12.0.2` 下生成；远端固定运行时重建摘要不同，因此未用于最终证明。
- 最终 C：`211ab186ca8ea9dc082d8e673efbd0257dcecee1`，仅更新受跟踪 `docs/releases/artifacts/v0.1.5.tgz`，SHA-256 为 `3c59b9c4eaa099812f886688ac90782a3048fc2053bc05d96617780ed35a09ae`。
- E：`15ee0415f576ce052f8369a7a3d5832c34e0620a`，直接父提交为最终 C，且仅新增 `docs/releases/attestations/v0.1.5.json`。
- annotated tag：`v0.1.5`，peeled target 为 E；tag 元数据、attestation、provenance、manifest 和 tarball 摘要均经验证器校验。

## 预检与发布

- 在 `arch-via-nas` 的临时目录使用 `Node v26.5.1` 和 `npm 12.0.1`，对最终 C 完成仓库原生 `release:preflight`。该操作验证测试、provenance、allowlist、工件重建、npm 身份和目标版本显式 404；没有读取、复制、记录或输出 npm token。
- 同一固定运行时对远端 `v0.1.5` 完整运行 `verify-release-evidence`，通过 annotated tag、E/C 父子关系和重建 tarball 摘要验证。
- GitHub Actions `Publish npm (manual)` run `31436590840` 成功：`validate` 和 `publish` 均完成，包括 exact tarball、离线安装、测试、provenance、allowlist、npm provenance、registry 下载 SHA-256 与签名审计。
- 发布后从 `arch-via-nas` 查询公开 registry 的 `@pennixrv/fast-context-skill@0.1.5`，下载 tarball SHA-256 仍为 `3c59b9c4eaa099812f886688ac90782a3048fc2053bc05d96617780ed35a09ae`。

## 约束与后续

- 本会话未执行本机 `npm login`、本机 `npm publish`、tag 重写或父仓库写入。
- 根仓库应使用其保留的验收查询独立复验已发布包；本任务不关闭根 Issue 055、056 或 057。
