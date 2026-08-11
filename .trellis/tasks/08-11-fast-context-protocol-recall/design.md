# 技术设计

## 基线与责任边界

修复分支从 `origin/main` 的 `604d741056acbf1bf84bdc3a71dedff9aea2fdb3` 创建。该提交是 `v0.1.5` tag 的后代；tag 与当前基线的 `package.json` 均为 `0.1.5`，并且 package allowlist 中的运行时文件没有差异。因此它包含实际已发布的 `0.1.5` 打包源码，同时避免从父仓库旧 Gitlink 的 detached 提交实施。

本设计处理远端工具对话的互操作性、终态约束和候选投影状态。Connect 解码、响应预算、凭据解析、PathGuard、ResourceBudget 和本地工具执行器沿用既有严格实现。取得 JWT 后，在仓库地图和流请求前追加与上游相同的 `CheckUserMessageRateLimit` 预检，固定使用 `MODEL_SWE_1_6_FAST`；请求体 gzip、共享当前剩余 deadline，且失败关闭，不采纳上游的网络失败后继续策略。仅对 `resource_exhausted`、`unavailable` 或 HTTP `429` 的同一流请求允许最多两次短退避；每次重新读取同一 budget 的剩余时间，不增加工具轮次或命令。

## 状态机修复

当前循环最多允许三轮 `restricted_exec` 的本地工具请求和一轮 answer-only 请求。本地证据充分时允许提前 `answer`；维持上限，并仅在第三个有效工具结果写入对话后追加一个 `role: user` 消息。消息明确要求：

- 现在只能调用 `answer`；不得再请求 `restricted_exec`；
- 候选必须使用 `<file path="/codebase/relative"><range>start-end</range></file>`；范围为正的闭区间，且只能基于本地工具已返回的证据；
- 无候选必须使用精确的 `<no_results/>` 或既有空 `<ANSWER></ANSWER>`，不得输出自然语言代替协议答复。

终态请求仍通过 `toolDefinitions({ allowRestrictedExec: false })` 仅暴露 `answer`。若解出的终态调用为 `restricted_exec` 或其他非 `answer` 工具，抛出 `FC_PROTOCOL_INVALID`。错误对象附带非枚举或内部可读的 `protocolReason`，值为固定枚举，例如 `answer_only_restricted_exec`，不会由 CLI 序列化，不含请求、响应、路径或凭据。

远端工具调用 JSON 的修正仍只允许每个阶段 `MAX_TOOL_FORMAT_RETRIES = 1`。第一次解析失败后追加不含远端文本的固定纠正用户消息，并使用同一个 `ResourceBudget` 的剩余时间发出一次替代请求；可执行工具阶段与最终 answer-only 阶段的计数分离，前者不消耗后者的唯一恢复机会，且任一阶段不补偿工具回合、不添加新轮次。候选因格式或范围被拒绝时，最多还有一次只暴露 `answer` 的格式修正；其空答复不能把第一次的候选证据降格为完整无结果。提示词把已读实现文件置于相关测试之前，但候选仍须本地复核。结构合法的 Connect EndStream `error` 不再被混同为帧解析失败：鉴权、超时、可用性/容量与服务端类别分别映射为既有固定 `FC_*`，而错误正文继续丢弃。

## 提示词兼容策略

fork 的压缩提示词保留安全禁止项，却缺少上游 v1.3.2 具备的具体调用示例、完整终态 XML 例子、无结果规则和强制终答消息，并错误要求工具信封必须从响应首字符开始。恢复最小必要信息：逐步推理、严格 `[TOOL_CALLS]name[ARGS]{JSON}` 示例、受限工具仅在 `/codebase`、终态 answer 示例、`<no_results/>`、同一 `<file>` 的多个精确 `<range>` 和最多结果数。信封前的文本只会在单次响应内被丢弃，绝不作为候选、命令、日志或后续会话内容；JSON 后只允许空白或 `</s>` 协议终止标记。不会恢复上游的 `parseJsonWithRepair`、`salvageRestrictedExecArgs`、`salvageSearchEvidence`、原始响应输出、缓存或额外补偿回合；这些会扩大接收面或泄露响应。

## 候选投影结果

`parseAnswer()` 将答案分为两个阶段：严格识别远端报告的 `<file ...>` 候选标记，再逐项经 PathGuard 的 `validateCandidateRange()` 验证。一个 `<file>` 可携带多个合法 `<range>`，每个范围是独立的候选计数和本地验证单位；相同文件的不同有效范围可同时返回，完全重复范围仍拒绝。结果新增固定结构：

```json
"projection": {
  "remote_candidates": 2,
  "accepted_candidates": 1,
  "rejected_candidates": 1,
  "unprocessed_candidates": 0,
  "rejection_reasons": ["remote_candidate_range_rejected"]
}
```

计数不保存原始路径、范围、XML 或拒绝细节。`unprocessed_candidates` 表示因
`maxResults` 上限未继续进行本地验证的远端候选，避免把它们错误计作拒绝。语义如下：

| 远端答复 | 本地投影 | 结果 |
| --- | --- | --- |
| 精确 `<no_results/>` 或空 `<ANSWER></ANSWER>` | 无候选 | `complete`、零候选、拒绝计数零 |
| 一个或多个严格候选 | 至少一个通过 | 返回通过项；若有拒绝则 `truncated` 并加入 `remote_candidate_projection_rejected` |
| 一个或多个候选标记 | 全部拒绝 | `truncated`、零候选、同一稳定原因，拒绝计数大于零 |
| 非显式无结果且无有效候选格式 | 无法确定语义 | `FC_PROTOCOL_INVALID` |

本地路径、范围、空文件、EOF、变更检测和 deny/symlink 拒绝均继续由 `validateCandidateRange()` 决定。预算中止或本地资源不可用维持现有失败关闭错误，而不降级为投影拒绝。达到 `maxResults` 时继续记录 `candidate_result_limit`；出现任意投影拒绝时也不宣称 `complete`。

## 测试设计

在 `test/fixtures/ledger-recall/` 放置等价四文件 TypeScript 夹具。`test/core.test.mjs` 使用临时副本、注入的 `fetchImpl` 和固定 Connect frames，不访问真实服务。测试直接解码发出的 protobuf 请求，以断言 force-answer 消息、终态工具定义和输出计数；响应正文只由合成非敏感字符串构成。
每个成功的受控 `readfile` 结果另携带仅供协议使用的 `read_range`，其值由实际返回的编号行计算；测试断言下一轮请求和终态 force-answer 指令只允许复用这一范围。该字段不进入 CLI JSON，候选投影仍在同一文件版本上重复范围复核。

真实探针在所有确定性验证后单独执行：从该夹具临时副本运行源入口和 tarball 入口，`env -u WINDSURF_API_KEY` 依赖已登录 Devin 发现。连续独立调用之间固定等待 3 秒，避免把一次性登录态容量窗口误测成协议失败；这只属于发布候选验收，不改变运行时重试、deadline 或工具预算。每次仅记录状态、候选数、经过本地核验的相对路径/范围、固定失败分类和终态工具名；Connect 错误仅保留固定内部类别，不保留远端正文、JWT 或 key。十次保留查询和三种等价措辞均须达成 PRD 门槛才允许发布。

## 发布设计

若所有质量和真实探针门槛通过，版本递增为补丁版本 `0.1.6`。遵循现有两阶段产物/证明流程：先提交源码 C，再在既有受控远端环境构建产物 C，提交只含无敏感证明的 E，创建签名注释 tag，验证发布证据、公开 tarball 与 registry SHA-256。不得在本机执行认证发布、不得输出 token、不得在父仓库更新 Gitlink。
