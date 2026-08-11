# 实施计划

## 1. 建立可重复基线

- 将四文件未知位置夹具加入测试资源，保留 `repairOrphanedSettlements()` 与对应测试的固定行范围。
- 为现有 Connect/Protobuf 注入夹具补充请求解码辅助，记录终态消息和工具定义但不记录远端原文；覆盖充分本地证据后的提前答复，不把最多三轮误实现为必须三轮。
- 在 JWT 后、仓库地图前补充受控 `CheckUserMessageRateLimit` 预检，验证固定模型、gzip 请求、共享 deadline 和拒绝后零地图/零流请求；不得引入额外凭据来源、重试或远端正文。
- 仅为固定容量/可用性分类补充最多两次同请求短退避，验证重试成功不增加工具轮次或命令、失败不越过共享 deadline；删除 fork 特有 `X-Request-Id`，不得加入追踪头或上游的 TLS 降级。
- 分离可执行工具阶段和 answer-only 阶段的一次格式纠正预算，验证前者成功后终态仍可修正；提示词要求有已读实现时不把测试单独作为答案，且不放宽 JSON、PathGuard 或范围复核。
- 让成功的受控 `readfile` 工具结果携带由实际输出行计算的内部 `read_range`；终态和格式修正提示词只能复用该范围，候选投影仍执行同一文件版本的二次复核，且该字段不进入公开 CLI JSON。
- 先编写会失败的测试：终态仍有 `restricted_exec`、答案含文件无范围后返回 `complete`/零候选、PathGuard 或范围拒绝后返回 `complete`/零候选。

## 2. 收敛协议与提示词

- 为系统提示词加入最小的工具、answer、显式无结果和结果上限示例；恢复逐步推理指令，但只解析工具信封，绝不把信封前远端文本带入后续请求或结果。
- 在最后一次有效本地工具执行后追加 force-answer 用户消息；最终请求保持只暴露 `answer`。
- 为终态违规和严格 Connect 边界使用固定内部协议原因，保留公开 `FC_PROTOCOL_INVALID`；工具 JSON 只允许一次带固定纠正消息的共享预算重试。
- 统一 JWT、预检和流请求的完整固定 Connect `User-Agent`；恢复逐步推理提示与同文件多精确范围的 XML 文法，但丢弃信封前文字、拒绝 JSON 尾随文字、绝不回放远端 thinking。
- 让直接执行的 source CLI、安装后 CLI 和 release 诊断都顶层等待其有界异步工作；本地保活计时器必须在 `finally` 清理，避免 Node 在 fetch 落定前以零退出码和空 stdout 结束。

## 3. 收敛候选投影

- 严格统计远端 `<file>` 与 `<range>` 候选标记，支持同一文件的多个精确范围，并逐个调用 PathGuard 范围复核；同文件仅完全重复的范围视为重复候选。
- 增加仅含固定计数与拒绝类别的 `projection` 元数据；将任意拒绝映射为 `truncated` 和 `remote_candidate_projection_rejected`。
- 仅精确 `<no_results/>` 或既有空 `<ANSWER></ANSWER>` 能表达完整无结果；模糊 prose 或不含候选格式的 answer 失败为 `FC_PROTOCOL_INVALID`。
- 保持候选路径、范围和原因均由本地验证生成，绝不回传远端 prose。

## 4. 契约、文档与打包

- 更新 CLI 安全规范、README/脚本契约中的终态和投影语义。
- 更新 source provenance 中已改运行时文件的规范化哈希和 allowlist 验证，不引入未声明发布文件。
- 新增 CLI JSON 和从 `npm pack` tarball 安装入口的回归覆盖。

## 5. 验证与发布门槛

- 执行 `npm test`、`npm run verify:provenance`、`npm run pack:check`、`npm pack --dry-run --json --ignore-scripts`、修改 `.mjs` 的 `node --check`、任务校验、`trellis update --dry-run`、`git diff --check` 和 `trellis-check`。
- 执行 WSL Devin 无显式 key 的十次保留查询与三种等价措辞，另测静态无效 key 的 `FC_AUTH_REJECTED`，只保存脱敏汇总。
- 验证源码和 tarball 安装入口一致后，才依发布合同完成 `0.1.6` 的产物、证明、tag、远端发布和公开 tarball SHA-256 验证。任一门槛失败时仅提交可复现修复候选，不发布。

## 当前验收结论

- 离线协议、CLI 生命周期和 tarball 安装入口测试均可重复通过；无效静态 key 保持 `FC_AUTH_REJECTED`。
- 真实三措辞诊断曾完成 3/3，本地验证目标实现范围，且无终态工具违规或投影伪空结果。
- 完整十次验收在修复 CLI 空 stdout 后仍受远端 `FC_REMOTE_UNAVAILABLE` 容量窗口阻断；该门槛未通过，因此候选只提交、不发布。详见 `research/live-probe-summary.md`。
