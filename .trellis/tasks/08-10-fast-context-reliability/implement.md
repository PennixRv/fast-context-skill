# 实施计划

## 0. Issue 050 与纯准备提交

- [x] 核验干净 `main`、三处固定哈希、Trellis 版本、无活动任务和 Codex inline 配置。
- [x] 创建 `fix/fast-context-reliability`，运行 `trellis update --create-new`。
- [x] 比较 10 个 `*.new`，拒绝纯空白与所有会弱化项目定制的上游 sidecar，清除 sidecar并保留安全备份。
- [x] 创建 planning 任务，读取根 Issue/审计证据和官方协议资料，写完整规划工件。
- [ ] 验证任务、Python/Hook、JSON/TOML、inline 输出、dry-run 和 `git diff --check`。
- [ ] 按路径确认准备提交不含产品文件，以固定提交信息提交并记录 PREP_COMMIT。

## 1. Issue 047/048：响应限制与 Connect decoder

- [ ] 在 `core.mjs` 增加流式、有压缩字节硬上限且可取消的响应读取。
- [ ] 在 `protobuf.mjs` 实现严格 envelope 状态机、gzip 协商、单帧/累计解压硬上限与唯一最终 EndStream。
- [ ] 用离线 `ReadableStream` 夹具覆盖单帧、多帧、gzip bomb、Content-Length 缺失/错误、慢速流与中途取消。
- [ ] 覆盖残头、长短长度、残片、未知 flags、gzip/协商错误和 EndStream 全部失败边界。
- [ ] 组合运行 core 与协议测试并执行修改 `.mjs` 的 `node --check`。
- [ ] 以明确负责 047/048 的产品提交落盘。

## 2. Issue 045/046：有界搜索与共享预算

- [ ] 新增集中命名的资源预算对象与默认上限，使用单调 deadline并合并外部 AbortSignal。
- [ ] 将 PathGuard 遍历/regularFiles/glob 改为异步 typed 结果，限制 entries/directories/depth/files/matches/elapsed。
- [ ] 修正 `**/` 的零目录与多目录语义，保持 deny/canonical root/symlink escape。
- [ ] 将 executor 改为可取消无 shell异步子进程，逐块限制输出并等待 close。
- [ ] 分批执行受 guard 约束的 `rg`，把 complete/truncated/failure 一致传给远端工具、公开 JSON 与最终状态。
- [ ] 测试第 513 个文件、宽/深目录、2,500 空目录、无匹配 glob、4 x 3 共享 deadline、调用方取消和无遗留进程。
- [ ] 记录小仓库可重复规模/延迟基准，更新 README/脚本契约。
- [ ] 组合运行 path-guard、executor、core 与 CLI 测试并提交负责 045/046 的产品变更。

## 3. Issue 049：候选范围复核

- [ ] 在 PathGuard 与统一预算内按固定文件版本验证候选范围，不 clamp。
- [ ] 集中命名最大跨度，拒绝 start/end 越界、空文件、跨度超限和验证期间变化。
- [ ] 覆盖无尾换行、最后一行、deny、根外、symlink escape 和至少一行可读性。
- [ ] 固定本地 reason/status，更新文档区分路径、范围和最终语义核验。
- [ ] 组合运行 core、PathGuard 与 CLI 测试并提交负责 049 的产品变更。

## 4. 全量质量门槛与收尾

- [ ] 使用 `trellis-check` 按 prd/spec/跨层数据流复核全部提交。
- [ ] 使用 `trellis-update-spec` 更新发生变化的安全与 CLI 契约。
- [ ] 运行 `npm test` 并按 045-050 记录具体测试证据，不只记录总数。
- [ ] 运行 `npm run verify:provenance`。
- [ ] 运行 `npm run pack:check`。
- [ ] 运行 `npm pack --dry-run --json --ignore-scripts` 并核对 allowlist。
- [ ] 对所有修改的 `.mjs` 运行 `node --check`。
- [ ] 运行 `python3 ./.trellis/scripts/task.py validate 08-10-fast-context-reliability`。
- [ ] 运行 `trellis update --dry-run` 与 `git diff --check`。
- [ ] 按 Trellis 流程归档任务、记录会话并提交收尾记录；不 push、不发布、不修改父仓库。
- [ ] 确认最终分支工作区干净并记录 FINAL_HEAD。

## 风险文件与复核点

- `scripts/lib/core.mjs`：凭据前置验证、共享 deadline、多轮调用和公开错误映射。
- `scripts/lib/protobuf.mjs`：Connect framing、gzip 与 EndStream 失败关闭。
- `scripts/lib/path-guard.mjs`：所有路径统一入口、deny 与 symlink 逃逸不回退。
- `scripts/lib/executor.mjs`：固定命令语法、子进程终止和输出硬上限。
- `scripts/fast-context-search.mjs`：公开 CLI JSON 与调用方 AbortSignal 契约。
- `README.md`、`references/script-contract.md` 与 `.trellis/spec/cli/fast-context-security.md`：声明必须与实现一致。

