# 稳定 Fast Context 终态协议与候选投影

## 目标

收敛 ROOT-ISSUE-058。以已发布 `v0.1.5` 的实际打包源码为修复基线，使真实“未知代码位置”查询在受控边界内稳定完成终态答复，并避免把远端返回而被本地拒绝的候选伪报为 `complete` 且零候选。

## 范围与约束

- 仅修改本组件仓库；不修改父仓库、父仓库 Issue/任务、Gitlink、`/home/penn/.codex` 或其他组件。
- 保持最多三轮可执行本地工具和一轮终态答复、共享截止时间、每轮命令上限、结果上限和格式重试上限；本地证据充分时必须允许提前答复，不得以额外轮次提高召回。
- 保持 PathGuard、canonical root、deny、符号链接逃逸防护、范围本地复核、输出预算、凭据发现与固定 `FC_*` 公开诊断。不得接受任意 prose、猜测 JSON、未验证路径或模型猜测行号。
- 凭据只在受控进程内存中使用；测试、日志、CLI JSON、任务记录与发布资产不得记录真实 API key、JWT、原始远端正文或敏感候选内容。
- 显式 `WINDSURF_API_KEY`、WSL/Linux Devin 自动发现和 `--no-external` 行为必须保持兼容。HTTP 401/403 继续归类为 `FC_AUTH_REJECTED`。
- 不在本任务中修改 `--no-ignore`、中文 `search_terms`、`--max-results` 既有诊断类别、64 KiB 读取策略、包依赖版本、发布工作流以外的发布安全规则。

## 已确认问题

受控四文件 TypeScript 夹具包含 `src/catalog/pricing.ts`、`src/ledger/repair.ts`、`src/notifications/dispatch.ts` 与 `test/ledger-repair.test.ts`。保留查询不包含目标文件或函数的字面量。根侧调试显示：

1. 终态 answer-only 请求虽移除了 `restricted_exec` 定义，但在最后一个有效工具回合之后未追加强制终答的用户消息；远端仍可能返回结构合法的 `restricted_exec`，当前客户端以笼统 `FC_PROTOCOL_INVALID` 结束。
2. `parseAnswer()` 对缺失 `<range>start-end</range>`、路径拒绝和范围拒绝静默跳过。远端已给出候选而全部被跳过时，当前结果仍可能是 `complete`/零候选，语义等同于错误的“无匹配”。
3. 原始 `fast-context-mcp v1.3.2` 在相同夹具中连续返回经本地可验收的 `src/ledger/repair.ts:1-24` 与 `test/ledger-repair.test.ts:1-11`。该事实是兼容性信号，不将上游的大范围重写或宽松响应修复直接视为本任务方案。

## 功能要求

- 最后一个有效 `restricted_exec` 执行后、终态请求前添加明确的用户级 force-answer 消息。终态消息必须要求仅调用 `answer`，禁止继续请求 `restricted_exec`，并规定候选 XML 与显式无结果格式。
- 终态工具定义继续只包含 `answer`。若远端仍返回 `restricted_exec`，公开错误仍为 `FC_PROTOCOL_INVALID`，并提供仅供受控测试使用、不含远端正文的稳定协议原因。
- 恢复必要但最小的系统提示词协议说明：工具调用格式、终态 answer 格式、路径/范围例子、结果上限和明确无结果格式。不得恢复上游的 JSON 修复、prose 证据回收、响应原文输出或无限补偿。
- 将候选投影分类为：远端明确无结果；至少一个候选通过本地投影；远端报告候选但全部被本地拒绝。第三种必须为结构化不完整结果，不能是 `complete`/零候选。
- 部分候选有效时，返回通过 PathGuard 和范围校验的候选，并以不含路径或远端文本的结构化计数与固定拒绝类别报告拒绝数量。任何拒绝使结果不宣称完整。
- 对缺少范围、格式错误、路径拒绝、范围拒绝、重复和文件变化等投影分支统一落实上述分类；本地预算/可用性故障仍按既有固定错误失败关闭。

## 验收标准

- [ ] 注入 `fetchImpl` 的确定性测试复现并修复终态 `restricted_exec` 与候选缺范围导致的伪 `complete`/零候选。
- [ ] 终态请求包含 force-answer 用户消息，定义中无 `restricted_exec`；终态继续返回该工具时得到 `FC_PROTOCOL_INVALID` 和稳定非敏感原因。
- [ ] 首次工具调用 JSON 非法时仅进行一次、共享截止时间内的格式重试，第二次合法可成功。
- [ ] 合法路径与合法范围返回本地有效候选；显式合法无结果才允许 `complete`/零候选。
- [ ] 缺范围、PathGuard 拒绝、范围越界的全部候选分别产生稳定 `truncated` 原因，不得伪报完整无结果；部分有效时仅保留有效候选并报告拒绝计数。
- [ ] 最大轮次、命令数、结果数和共享截止时间的既有测试继续通过；测试快照、stderr 与 JSON 不含凭据、JWT 或完整远端响应。
- [ ] 使用 WSL Devin 登录态和四文件保留夹具完成至少十次同一查询及三种等价措辞的受控探针：每次有本地验证的 `src/ledger/repair.ts` 范围，零 `FC_PROTOCOL_INVALID`，零“远端候选后 complete/0”伪成功，终态无 `restricted_exec`。
- [ ] 无显式 `WINDSURF_API_KEY` 时使用 Devin 登录态；无效显式 key 稳定为 `FC_AUTH_REJECTED`；npm tarball 安装入口与源码入口行为一致。
- [ ] 通过仓库 lint/类型/单元/集成/打包验证、`trellis-check` 与任务校验；提交后工作区干净。仅在上述门槛全部通过后才依既有发布流程发布并校验公开 tarball。
