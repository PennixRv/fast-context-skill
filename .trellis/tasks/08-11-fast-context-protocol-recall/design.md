# 技术设计

## 基线与责任边界

修复分支从 `origin/main` 的 `604d741056acbf1bf84bdc3a71dedff9aea2fdb3` 创建。该提交是 `v0.1.5` tag 的后代；tag 与当前基线的 `package.json` 均为 `0.1.5`，并且 package allowlist 中的运行时文件没有差异。因此它包含实际已发布的 `0.1.5` 打包源码，同时避免从父仓库旧 Gitlink 的 detached 提交实施。

本设计只处理远端工具对话的终态约束和候选投影状态。Connect 解码、响应预算、凭据解析、PathGuard、ResourceBudget 和本地工具执行器沿用既有严格实现。

## 状态机修复

当前循环固定为三轮允许 `restricted_exec` 的本地工具请求和一轮 answer-only 请求。维持该上限，并在第三个有效工具结果写入对话后追加一个 `role: user` 消息。消息明确要求：

- 现在只能调用 `answer`；不得再请求 `restricted_exec`；
- 候选必须使用 `<file path="/codebase/relative"><range>start-end</range></file>`；范围为正的闭区间，且只能基于本地工具已返回的证据；
- 无候选必须使用精确的 `<no_results/>` 或既有空 `<ANSWER></ANSWER>`，不得输出自然语言代替协议答复。

终态请求仍通过 `toolDefinitions({ allowRestrictedExec: false })` 仅暴露 `answer`。若解出的终态调用为 `restricted_exec` 或其他非 `answer` 工具，抛出 `FC_PROTOCOL_INVALID`。错误对象附带非枚举或内部可读的 `protocolReason`，值为固定枚举，例如 `answer_only_restricted_exec`，不会由 CLI 序列化，不含请求、响应、路径或凭据。

远端工具调用 JSON 的修正仍只允许 `MAX_TOOL_FORMAT_RETRIES = 1`。第一次解析失败后追加不含远端文本的固定纠正用户消息，并使用同一个 `ResourceBudget` 的剩余时间发出一次替代请求；不补偿工具回合、不添加新轮次。候选因格式或范围被拒绝时，最多还有一次只暴露 `answer` 的格式修正；其空答复不能把第一次的候选证据降格为完整无结果。

## 提示词兼容策略

fork 的压缩提示词保留安全禁止项，却缺少上游 v1.3.2 具备的具体调用示例、完整终态 XML 例子、无结果规则和强制终答消息。恢复最小必要信息：严格 `[TOOL_CALLS]name[ARGS]{JSON}` 示例、受限工具仅在 `/codebase`、终态 answer 示例、`<no_results/>` 和最多结果数。不会恢复上游的 `parseJsonWithRepair`、`salvageRestrictedExecArgs`、`salvageSearchEvidence`、原始响应输出、缓存或额外补偿回合；这些会扩大接收面或泄露响应。

## 候选投影结果

`parseAnswer()` 将答案分为两个阶段：严格识别远端报告的 `<file ...>` 候选标记，再逐项经 PathGuard 的 `validateCandidateRange()` 验证。结果新增固定结构：

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

真实探针在所有确定性验证后单独执行：从该夹具临时副本运行源入口和 tarball 入口，`env -u WINDSURF_API_KEY` 依赖已登录 Devin 发现。每次仅记录状态、候选数、经过本地核验的相对路径/范围、固定失败分类和终态工具名；Connect 错误仅保留固定内部类别，不保留远端正文、JWT 或 key。十次保留查询和三种等价措辞均须达成 PRD 门槛才允许发布。

## 发布设计

若所有质量和真实探针门槛通过，版本递增为补丁版本 `0.1.6`。遵循现有两阶段产物/证明流程：先提交源码 C，再在既有受控远端环境构建产物 C，提交只含无敏感证明的 E，创建签名注释 tag，验证发布证据、公开 tarball 与 registry SHA-256。不得在本机执行认证发布、不得输出 token、不得在父仓库更新 Gitlink。
