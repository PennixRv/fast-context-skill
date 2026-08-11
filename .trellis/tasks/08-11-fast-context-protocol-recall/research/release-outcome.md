# `v0.1.7` 发布结果

## 发布链

- 纠正源码提交：`68952031f3558916204ea34beac224db55e7fd5a`。
- 工件提交：`7742c9311857dff65e55a48040f655d23537bd1c`，只新增
  `docs/releases/artifacts/v0.1.7.tgz`。
- 证明提交：`c92d18fda2a63edd30940262fce985640650f4d7`，只新增
  `docs/releases/attestations/v0.1.7.json`。
- annotated tag：`v0.1.7`，tag object
  `3561e6abc434c0ea60460364b29b0797c870558d`，peel 到证明提交。
- GitHub Actions：`Publish npm (manual)` run `31479430458`；`validate` 与
  `publish` 均为 `success`。
- 公开包：`@pennixrv/fast-context-skill@0.1.7`。

## 工件与独立复核

- 正式 tarball 在 `arch-via-nas` 临时目录中以官方下载且 SHA-256 校验通过的
  `Node v26.5.1` 和临时 `npm 12.0.1` 构建；源码精确绑定工件提交的父提交。
- tarball SHA-256：
  `ca7fb70d92638f7e2ca368940e651f8a6ec3dc3ed4a9d95e5c995a42b97e2447`；
  39,946 bytes、17 个 package 条目，不含 `docs/releases` 历史证据目录。
- NAS 认证 preflight 通过：完整测试、provenance、包内容、npm 登录态、目标版本
  显式未存在、固定工件重建和证明生成均成功。
- 推送 tag 前，先通过临时 Git bundle 在同一固定 NAS 工具链执行
  `release:verify-evidence`，结果为 `release evidence ok`；公开 npm tarball 发布后
  再由 NAS 独立下载，SHA-256、字节数和条目数与证明完全一致。
- 发布工作流的 `validate` 重新执行 110/110 测试，覆盖导致 `v0.1.6` 发布门失败的
  无宿主 `rg` 场景；随后才执行精确 tarball 的 provenance 发布。

## `v0.1.6` 与残余风险

- 已推送的 `v0.1.6` tag 保持不可变。对应 run `31477461013` 在发布前测试门失败，
  `publish` 被跳过，npm registry 中没有 `0.1.6`；没有删除、移动或复用该 tag。
- 修复后真实保留查询的完整 `10/10`、三种措辞和 packed 入口门槛没有在容量窗口
  恢复后重新执行。原版 MCP 在同一窗口也返回固定容量/速率限制。用户明确接受该
  外部状态导致的残余风险并授权发布；本文不把该门槛记为通过。
- 本组件发布不代表根仓库 Issue 已关闭。没有修改父仓库、父仓库 Gitlink、其他组件
  或 `/home/penn/.codex`，也没有在本机执行 `npm publish` 或读取、输出 npm/Windsurf
  凭据。
