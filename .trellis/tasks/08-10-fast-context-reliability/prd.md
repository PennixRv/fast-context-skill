# Harden Fast Context reliability and bounded search

## 目标

修复 Fast Context 在响应缓冲、Connect streaming 解码、本地搜索覆盖、端到端资源预算和候选行范围复核上的失败开放边界，使所有远端与本地工作都在统一安全约束内失败关闭，同时保持现有 PathGuard、公开诊断、包内容和发布安全契约。

## 背景与已确认事实

- 固定起点为 `ae36a92847ce248dfb5d2ee77080b91e00360496`，`HEAD`、`main` 与 `origin/main` 在任务开始时一致，工作区干净。
- Issue 050 的 Trellis 基线必须先于产品代码处理；项目由 `0.6.10` 更新到本机 CLI `0.6.14`，更新使用 `trellis update --create-new`，不使用 `--force`。
- 当前实现会先调用 `response.arrayBuffer()`，随后才检查响应长度；gzip 解压没有硬输出上限，Connect decoder 对帧长度、flags、残片和 `EndStreamResponse` 校验不足。
- `PathGuard` 的文件遍历在找到 512 个文件后直接停止，却把该集合当作完整 `rg` operand；`**/*.mjs` 不能匹配根目录文件。
- 本地目录遍历没有统一的条目、目录、深度、文件、匹配、输出字节和 elapsed 预算；`execFileSync` 不可由调用方取消；最多 4 命令乘 3 轮及网络请求各自重新获得完整 timeout。
- 候选路径会经过 PathGuard，但远端给出的 `start_line`/`end_line` 只检查正整数和顺序，不检查 EOF、跨度或验证期间文件变化。
- 所有协议和网络测试必须使用脱敏离线夹具与注入的 fetch/stream；不得读取或使用真实 `WINDSURF_API_KEY`，不得调用 Windsurf 服务。

## 范围与要求

### Issue 050：Trellis 准备基线

- 将项目 Trellis 版本更新到 `0.6.14`，保留安全备份到准备提交验证完成。
- 保留 Codex inline、主会话唯一写入和仅可通过显式 `trellis channel` 做有界委派的项目定制。
- `.trellis/config.yaml` 保持 `codex.dispatch_mode: inline`；`.trellis/agents/{implement,check}.md` 保持 `provider: codex`。
- `.codex/hooks.json` 仅注册 `UserPromptSubmit`，`.codex/config.toml` 不启用原生 agents；五个刻意删除的原生 Codex 资产继续不存在。
- 逐项裁决全部 `*.new`，拒绝纯空白差异，清除 sidecar；`trellis update --dry-run` 不再提示版本升级。
- 在任何产品修改前提交纯准备基线，提交信息固定为 `chore(trellis): prepare Fast Context reliability task`。

### Issue 047：响应和解压硬上限

- `postBinary` 流式读取 `Response.body`，在复制完整响应前限制累计压缩字节；`Content-Length` 仅作提前拒绝提示，不作为唯一可信依据。
- 分别限制单帧压缩字节、单帧解压字节和整份响应累计解压字节，常量集中命名并注明单位与作用层级。
- gzip 使用 Node `zlib` 的 `maxOutputLength` 或等价流式限制；解压失败或膨胀超限不得回退原 payload。
- 避免整包重复 `Buffer` 复制；超限或结构错误稳定映射为 `FC_OUTPUT_LIMIT` 或 `FC_PROTOCOL_INVALID`。
- 公开诊断不得包含响应正文、绝对路径、凭据或底层异常原文。

### Issue 048：严格 Connect streaming 解码

- 严格按 `1 B flags + 4 B big-endian length + exact payload` 消费整个输入。
- 拒绝不足 5 B 的残头、长度过长/过短、尾随残片、未知或不支持 flags、无效长度和整数异常。
- 压缩 flag 必须与 negotiated encoding 一致；gzip 失败不得 raw fallback。
- 响应必须包含唯一且最终的 `EndStreamResponse`；拒绝缺失、重复、提前、之后仍有 frame，以及携带远端 error 的 EndStream。
- 正常单帧、多帧、gzip/identity 与成功 EndStream 保持可解析；047 与 048 的测试必须组合运行。

### Issue 045：可解释的搜索覆盖

- 文件枚举返回 typed 状态，显式区分 `complete`、`truncated` 与 `failure`，并携带 `visited` 和足够的 continuation/边界信息。
- 第 513 个及后续文件不得静默表现为 `(no matches)`；不能只增大常量，也不能改成无界扫描。
- 使用分批、受控分区或受 PathGuard 约束的 ripgrep 目录策略，确保搜索遗漏可解释且受资源预算限制。
- 截断作为 typed tool result 传给远端模型，并在公开 CLI JSON/最终结果中保留必要的不完整语义。
- glob 的 `**/` 同时匹配零目录和多目录；覆盖根级、嵌套、无匹配、deny、符号链接和 100 结果上限。
- README 与契约只声明可证明的覆盖和降级，不宣传完整仓库搜索。

### Issue 046：一次 search 共享的端到端资源预算

- `search()` 创建单一资源预算对象，使用单调时钟计算 deadline，并接受调用方 `AbortSignal`。
- 所有网络请求、目录遍历、glob、ripgrep 子进程、多命令和多轮调用消费同一剩余预算，不为步骤重置 timeout。
- 同时限制 visited entries、directories、depth、files、matches、输出字节和 elapsed；预算耗尽必须返回 typed truncation/failure。
- 宽目录、深目录、2,500 空目录和无匹配 glob 必须在固定预算内停止并报告截断。
- 同步遍历与 `execFileSync` 改为可取消异步实现；子进程 timeout/abort 后等待并确认终止，不遗留进程。
- 最多 4 命令乘 3 轮仍受一个可测试总截止时间约束；调用方取消、网络超时和本地超时快速收敛。
- 为正常小仓库记录可重复规模与延迟基准，防止明显性能回退。
- typed result、公开 CLI JSON 与远端 tool result 的 complete/truncated/failure 语义一致。

### Issue 049：候选范围本地真实性复核

- 在 PathGuard 和同一资源预算内复核 `start_line`/`end_line`。
- `start` 超过 EOF、`end` 超过 EOF、空文件或跨度超过命名上限时失败关闭；默认丢弃远端范围，不静默 clamp。
- 每个返回范围必须能从同一固定文件版本读取至少一行并受最大跨度限制。
- 验证前后文件发生变化时安全降级；不得读取 deny、根外或符号链接逃逸路径。
- `reason` 与状态由本地固定定义，不透传远端 prose。
- 文档区分路径复核、范围复核和调用方最终语义核验。

## 必须保留的安全契约

- `PathGuard` 仍是所有 rg、read、listing、tree、glob、repository map 和 candidate 路径的统一入口；hard deny、附加 deny、canonical root 和 symlink escape 语义不能弱化。
- 不引入任意 shell、任意命令、cwd 默认、凭据参数或远端 prose 透传。
- `WINDSURF_API_KEY` 是唯一凭据来源，并在任何 core import、DNS、socket 或 fetch 前验证。
- 公开失败继续使用固定 `FC_*` 诊断，不泄露内部错误、响应内容、路径或凭据。
- 保持 Node `>=20`、现有 npm 包内容 allowlist 和 provenance/release 安全规则。
- 只修改组件仓库，不修改父仓库 issue、任务、Gitlink 或 Git；不 push、不发布、不打 tag、不全局安装。

## 非目标

- 不改变 `--no-ignore` 或 `.gitignore` 文件对外部模型的可见策略。
- 不处理中文查询 `search_terms` 为空。
- 不改变 `--max-results` 使用的诊断类别。
- 不改变大于 64 KiB 文件不能整文件读取的现有限制。
- 不升级包版本，不生成 release artifact，不打 tag，不执行 `npm publish` 或全局安装。
- 新发现只记录到本任务 research 与最终报告，除非它阻塞固定验收，不扩张实现范围。

## 依赖顺序

1. Issue 050 准备提交。
2. Issue 047 与 048：共同关闭网络响应和 Connect decoder 的底层失败开放路径。
3. Issue 045 与 046：在严格协议基础上建立共享资源预算与可解释搜索覆盖。
4. Issue 049：在稳定的 PathGuard 与预算上完成候选范围复核。

## 独立验收清单

### 045

- [ ] 第 513 个及后续文件不会静默退化为 `(no matches)`，截断有 typed 状态与 continuation/visited 信息。
- [ ] `**/` 覆盖零目录和多目录，根级/嵌套/deny/symlink/无匹配/100 上限离线测试通过。
- [ ] README、脚本契约、远端 tool result 和公开 CLI JSON 对 incomplete 语义一致。

### 046

- [ ] 一次 `search()` 的网络、遍历、glob、rg、多命令和多轮共享单调 deadline 与调用方取消信号。
- [ ] entries/directories/depth/files/matches/output bytes/elapsed 均有集中命名硬上限。
- [ ] 宽/深/2,500 空目录及无匹配 glob 有界停止并报告截断。
- [ ] 子进程在 timeout/abort 后确认退出且测试证明无遗留进程；4 x 3 路径仍受总截止时间约束。
- [ ] 小仓库规模与延迟基准可重复且无明显回退。

### 047

- [ ] 压缩响应在完整缓冲前受硬上限，缺失或错误 `Content-Length` 不绕过限制。
- [ ] 单帧压缩、单帧解压和累计解压硬上限均有离线测试。
- [ ] gzip bomb、解压失败、慢速流和中途取消失败关闭且诊断脱敏。

### 048

- [ ] 残头、长度过长/过短、尾随残片、未知 flags、压缩协商错误和错误 gzip 全部失败关闭。
- [ ] 缺失/重复/提前/非最终/远端 error 的 EndStream 全部失败关闭。
- [ ] 正常单帧、多帧、identity/gzip 和成功 EndStream 与 047 组合测试通过。

### 049

- [ ] start/end 越界、跨度超限、空文件和验证期间变化时不返回候选。
- [ ] 无尾换行与最后一行范围保持有效；每个返回范围可从同一文件版本读取至少一行。
- [ ] deny、根外和 symlink escape 路径仍失败关闭，reason/status 不透传远端 prose。

### 050

- [ ] 项目与 CLI 版本均为 `0.6.14`，无遗留 `*.new`，dry-run 不提示升级。
- [ ] Codex inline、channel-only 委派、`provider: codex`、无 `SubagentStart` 与五个刻意删除资产均保持。
- [ ] 纯准备提交先于且不包含 `scripts/`、`test/`、`package.json`、`README.md`、`SKILL.md`、`references/` 产品契约或发布资产。

## 完成门槛

- 运行 `npm test`、`npm run verify:provenance`、`npm run pack:check`、`npm pack --dry-run --json --ignore-scripts`。
- 对所有修改的 `.mjs` 运行 `node --check`。
- 运行 `python3 ./.trellis/scripts/task.py validate 08-10-fast-context-reliability`、`trellis update --dry-run` 与 `git diff --check`。
- 使用 `trellis-check` 完成全量质量检查；契约变化通过 `trellis-update-spec` 更新组件 spec。
- 按依赖阶段本地提交，不 squash 准备提交；最终归档任务并保持工作区干净。

