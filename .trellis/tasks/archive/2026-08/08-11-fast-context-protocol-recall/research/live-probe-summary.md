# 受控真实探针摘要

## 方法

在 WSL 中从临时四文件夹具运行 `scripts/release/live-probe.mjs --diagnose`。环境显式移除
`WINDSURF_API_KEY`，只允许既有 Devin 登录态的受控发现。探针只记录本地验证后的相对路径和范围、
候选计数、固定公开失败码、固定内部协议类别以及工具名称；不保存 key、JWT、远端正文、远端错误
文本、请求 ID、绝对路径或响应帧。

## 结果

在本任务的离线协议修复通过后，三种等价保留查询曾出现两类未通过结果：

1. 严格 Connect 解码识别到远端以 EndStream 错误结束。公开结果保持
   `FC_PROTOCOL_INVALID`；受控观察通道只保留固定
   `connect_end_stream_remote_error` 类别。未记录远端错误文本或未受控字段。
2. 随后的重复诊断收敛为 `FC_REMOTE_UNAVAILABLE`。同样没有候选、正文或凭据记录。

对照原始 `fast-context-mcp v1.3.2` 的请求构造后，仅恢复了
`Accept-Encoding: identity` 和完整 Connect Go `User-Agent` 两个不含设备、凭据或追踪数据的兼容
字段。该局部调整没有在上述探针中消除远端拒绝，因此不能被描述为已解决根因。

## 结论

确定性测试证明本地状态机、格式修正、严格 Connect 失败关闭和候选投影契约可重复；真实服务
验收的十次保留查询、三种措辞和 tarball 入口门槛尚未满足。当前候选不得发布。后续应在服务
可用时复跑 `scripts/release/live-probe.mjs`，只接受其全部检查为真时再进入现有发布流程。

最后一次完整聚合的十次保留查询为：1 次本地验证目标成功、2 次 `truncated` 且零候选、7 次
`FC_PROTOCOL_INVALID`。两种额外措辞均为 `FC_PROTOCOL_INVALID`；离线安装 tarball 的三种措辞
也均为 `FC_PROTOCOL_INVALID`。`zero_pseudo_complete_empty` 为真，说明没有将远端候选投影问题
伪报为完整零候选；无效静态 key 的 `FC_AUTH_REJECTED` 与空 stdout 检查亦为真。该次临时打包
产物的 SHA-256 为
`91c0e17d7113464bae1bab708d3caadaa620a2bc4028561419354876946f87aa`；它只用于本次未发布候选
的入口一致性记录，不是 registry 或公开 tarball 证明。

## 后续受控诊断

在恢复可读仓库地图和精确工具 envelope 说明后，三个受控诊断均未达到发布门槛。第一项经过一次
有界工具格式纠正后完成两轮本地 `restricted_exec`；其后远端以固定
`connect_end_stream_resource_exhausted` 结束。第二项同样在两轮本地工具之后以该类别结束，第三项
在首轮即结束。所有记录仍只有本地命令状态、固定类别和本地候选计数，没有远端正文、错误文本、JWT、
key、请求 ID 或绝对路径。

该结果确认了两项 fork 回归：提示词错误地要求用尽三轮工具，且结构合法的远端容量 EndStream 被误报为
`FC_PROTOCOL_INVALID`。修复将前者收敛为“最多三轮，证据充分即答复”，并将后者映射为
`FC_REMOTE_UNAVAILABLE`，同时保留不公开的固定 `connect_end_stream_resource_exhausted` 原因。后续公开上游
源码对照还确认 fork 缺少 JWT 后的 `CheckUserMessageRateLimit` 请求；现已在本地以固定模型、gzip、共享
deadline 和拒绝即停止的方式恢复，并有注入测试。它仍不构成真实召回通过证明；为避免在容量拒绝期间制造
更多噪声，下一次完整十次探针会等待服务窗口恢复后执行。

中性 metadata 结构完成后，三措辞诊断均显示预检已完成，随后首条流请求以
`connect_end_stream_resource_exhausted` 失败。这证明预检不再是当前阻塞点，但也不表示真实召回通过。
为与上游受控容量重试对齐，客户端后续仅对该固定容量/可用性类别重发同一流请求，最多两次且共享
deadline；其离线帧回归成功，尚待受控真实探针验证。

启用容量重试后的三措辞探针不再出现首流容量拒绝，但仍未通过召回门槛：一项为 `truncated`，仅保留
本地有效的测试范围并报告一个范围拒绝；一项在终态工具 envelope 格式错误后为
`FC_PROTOCOL_INVALID`；一项为完整但只返回测试范围。三项预检均完成，终态没有 `restricted_exec`。
这证明候选投影没有再伪报完整零结果，但显示全局格式纠正预算会遮蔽终态恢复、且提示词没有稳定优先
实现文件。相应修复现有离线帧回归，尚待下一轮受控真实探针。

## 最近受控结论

补充本地 `read_range` 协议锚点、终态 force-answer 范围说明、阶段独立格式纠正和实现优先提示后，受控
三措辞诊断连续三次通过：每项均完成 JWT 与 rate-limit 预检，终态仅调用 `answer`，并返回经本地复核的
`src/ledger/repair.ts` 与测试范围。该短批次证明所修正的状态机和投影路径可用，但不能替代发布门槛。

紧接着的完整受控批次未通过：十次保留查询仅两次命中目标，其他项为固定
`FC_PROTOCOL_INVALID` 或 `truncated`；三种额外措辞及临时 tarball 入口亦存在固定协议失败。所有项继续满足
`zero_pseudo_complete_empty`，无效静态 key 仍为 `FC_AUTH_REJECTED` 且 stdout 为空。故当前候选不能发布，也不将
短批次成功表述为 ROOT-ISSUE-058 已解决。

随后在真实 WSL 宿主入口以显式移除 `WINDSURF_API_KEY` 进行单次脱敏复核：固定 Devin 凭据辅助发现成功，JWT
请求却在连接建立前发生 `transport_failure`，没有预检、流、工具调用或远端正文。公开结果为
`FC_REMOTE_UNAVAILABLE`，未记录底层异常、URL、头、凭据、JWT、请求 ID 或响应内容。该环境传输失败阻塞了
宿主侧的后续十次复验；它不改变上述完整批次未通过的结论，也不能用作协议修复完成的证据。

## 2026-08-11 再对照与入口修复

对照公开 `fast-context-mcp v1.3.2` 后，确认 fork 还存在三项兼容差异：JWT 请求使用缩短的
Connect `User-Agent`、提示词错误禁止逐步推理且只接受每文件首个范围、一次性 CLI 不等待异步
`runCli()`。前两项会改变远端模型的协议上下文；最后一项会使 Node 在网络 promise 落定前以
空 stdout 退出。原始 MCP 是常驻服务，不暴露后一种生命周期问题。

本任务已统一三个请求阶段的固定 `User-Agent`，恢复逐步推理与同文件多精确范围的 XML 文法，
并将信封前文字只作单次丢弃、JSON 尾随文字仍作有界格式失败。CLI 与 release 诊断入口均以
顶层等待和清理后的本地保活计时器收敛；不回放远端 thinking，不采用 JSON 修复、prose 回收、
TLS 降级、主机指纹或额外工具轮次。探针的独立调用间隔固定为 3 秒，仅防止验收突发消耗同一
登录态容量窗口，不改变产品客户端的重试或 deadline。

新的三措辞受控诊断曾 3/3 完成 JWT、预检和 HTTP 200 流请求，终态均为 `answer`，并返回本地
验证的 `src/ledger/repair.ts`（1-22）与测试范围，零 `FC_PROTOCOL_INVALID`、零投影拒绝。完整
source/tarball 批次随后确认入口空 stdout 回归已消除：前五个 source 调用均产生 JSON，其中四个
命中目标，且该批次 `FC_PROTOCOL_INVALID` 为零；之后服务固定收敛为 `FC_REMOTE_UNAVAILABLE`。
另一轮 3 秒间隔的完整批次在首项后同样进入可用性失败。两轮均保持零伪 `complete/0`，无效静态
key 继续为 `FC_AUTH_REJECTED` 且 stdout 为空。由于十次成功、三种措辞和 tarball 真实入口门槛尚未
全部满足，候选仍不得发布。所有记录仅含固定状态、计数和本地验证相对范围；没有 key、JWT、请求
标识、绝对路径或远端正文。

## 2026-08-11 交错请求差分与结论修正

为区分服务容量、请求形状和 fork 实现差异，在临时四文件夹具中以 `env -u WINDSURF_API_KEY` 运行了
低频、脱敏的交错探针。探针只保留阶段、HTTP 状态、固定头是否存在、请求字节/字段长度、固定公开
错误码和固定 Connect 类别；不保留 API key、JWT、请求/响应正文、请求标识、绝对路径或临时目录。

在可连通窗口中，fork 的 JWT 与 `CheckUserMessageRateLimit` 均为 HTTP `200`，第一条流请求及其两次
有界重试均以结构合法的 `connect_end_stream_resource_exhausted` 结束。将公开 MCP `v1.3.2` 临时副本
替换为与 fork 相同的固定 OS/CPU/内存 metadata、移除 Sentry 头后，不能据此证明 MCP 成功：旧 MCP 的
宽松 Connect 解码会把终止错误投影为普通 `{ files: [], error: ... }` 结果。早期比较器仅根据存在
`files` 数组将其归为“结果”，这是错误分类，已在比较器中改为只记录 `remote_error_present` 与
`raw_response_present` 布尔值；此前零候选的 MCP 对照不再作为服务可用或召回成功证据。

已完成的结构对齐实验也不能作为产品修复依据：在临时副本中单独或组合恢复 MCP 的完整提示词、丰富
工具 schema、八个命令槽位、深度三地图包装和固定 `Connect-Timeout-Ms: 30000`，fork 仍收到同一固定
容量终止。最后一次对齐试验中，已记录的首流字段长度、固定 Connect 头和压缩帧长度与安全化 MCP
副本一致；但两端各自取得 JWT，且不会读取、导出或复用真实 JWT。因此该实验排除了若干明文请求
结构假设，不能排除短暂服务容量或 JWT 会话分配差异。

随后 fork 和 MCP 的 JWT 请求均出现连接建立前的 `transport_failure`，没有产生可比流结果。真实网络
验收在此停止，避免把传输故障扩大为重复探针。当前可信结论是：fork 必须继续将有效 Connect
`resource_exhausted` 失败关闭为 `FC_REMOTE_UNAVAILABLE`；不得模仿旧 MCP 将远端错误折叠为零候选结果。
尚无足够证据将剩余不稳定性归因于 metadata、Sentry、提示词长度、命令槽数量、地图包装或声明超时。

## 2026-08-11 标准 MCP 入口与 fork 正式 CLI 对照

为避免把内部 `search()` 调用误当作产品验收，新增了仅通过原始 `v1.3.2` `src/server.mjs` 的
stdio JSON-RPC 入口探针。探针显式移除 `WINDSURF_API_KEY`，只继承 SDK 允许的基础环境变量，并以
`FC_HIDE_EXTRACT_WINDSURF_KEY_TOOL=1` 隐藏凭据提取工具；输出只保留固定类别、本地范围复核布尔值和
工具可见性。首次标准入口调用返回本地核验的目标候选，工具列表包含搜索工具且不包含凭据提取工具。

同一受控窗口追加的三次上游标准入口调用均完成 stdio 协议，但返回上游错误表面，没有可核验候选。
因此这组结果不能证明上游四次稳定成功，也不能把上游错误折叠成“空结果”；根侧此前的连续成功记录
仍是另一服务窗口的有效证据。该对照说明真实服务波动同时影响原始 MCP 和 fork，当前不能仅凭服务失败
把 fork 的剩余问题归因于请求方法。

在相同四文件夹具和保留查询上，fork 的正式 `scripts/fast-context-search.mjs` 连续四次出现
`truncated`、零候选、一个远端候选且 `remote_candidate_range_rejected`，以及两次 `complete`、两个
候选且目标范围本地核验通过；加上此前同查询的一次失败和一次成功，说明 fork 当前保留了失败关闭
语义，但远端答复的范围仍不稳定。仓库脱敏诊断入口的三种查询均为 HTTP `200` 流、预检完成、终态
只调用 `answer`，未再出现终态 `restricted_exec`；其中两轮本地工具完整，最终两个候选全部被范围
复核拒绝，仍报告 `truncated` 而不是 `complete/0`。

当前判定分为三层：

1. 上游旧解析器比 fork 宽松，会把未严格本地复核的范围放进普通文件结果；这解释了兼容性差异，
   但不构成放宽 `PathGuard`、EOF 或跨度校验的理由。
2. fork 的状态机修复已生效：最终请求只暴露 `answer`，force-answer 消息存在，拒绝候选不会伪报
   完整零结果。
3. 剩余召回问题需要继续区分远端模型偶发生成不合规范围与 fork 请求上下文差异；当前证据不足以
   宣称任一方是唯一根因，也不足以进入发布门槛。

## 2026-08-11 `read_range` 尾换行回归定位

对 fork 的 `PathGuard.validateCandidateRange()` 做了临时、脱敏的数值级包装，只记录目标文件类别、
起止行、跨度、是否通过和固定异常码，不保存候选路径或远端答复。失败样本稳定显示远端依据工具结果
返回目标文件 `1-25`、测试文件 `1-12`，而夹具的真实 EOF 分别为 24 行和 11 行；严格范围校验拒绝
它们是正确的。后续一次有界答复修正有时返回 `1-22` 与 `1-10` 并通过，部分候选有效时也正确报告
`truncated` 和拒绝计数。

根因在 fork 本地 `readText()`：对尾换行文件使用 `content.split("\\n")` 后直接以 `lines.length`
生成 `read_range`，尾部空分段被宣告为额外一行。`validateCandidateRange()` 使用真实 EOF 计算，
于是远端严格照抄了客户端自己错误宣告的范围，形成确定性投影失败。修复只在读取分段时移除尾部
空分段，保留空文件、无尾换行和超出 EOF 的失败关闭语义；新增 PathGuard 回归覆盖尾换行和无尾换行，
核心协议测试 41/41 通过。

修复后正式 CLI 的下一批请求遇到 `FC_REMOTE_UNAVAILABLE` 且无 stdout JSON，未形成新的召回统计；
该结果是服务可用性失败，不应与 `remote_candidate_range_rejected` 混淆。待服务窗口恢复后，必须
重新执行标准 MCP、fork 源码 CLI、安装后入口和三种措辞的完整受控验收。

## 2026-08-11 修复后完整候选验收

在提交 `8e9cf46` 后运行仓库既有完整入口，环境移除显式 `WINDSURF_API_KEY`，只使用 Linux/WSL Devin
自动发现。10 次 source 保留查询得到 2 次 `complete` 且命中 `src/ledger/repair.ts`，1 次
`truncated` 保留测试候选，1 次 `FC_PROTOCOL_INVALID`，6 次 `FC_REMOTE_UNAVAILABLE`；没有
`complete`/零候选伪成功。source 三种措辞和 packed 三种措辞均在服务降级后返回
`FC_REMOTE_UNAVAILABLE`，因此 packed 入口本次没有获得可比较的成功样本。

该批次的无效静态 key 检查为 `FC_AUTH_REJECTED` 且 stdout 为空；packed 临时 tarball 的 SHA-256
为 `3c9a85bf0ffb91709b9d6f67c9ca8799ac51a5bb5aae66c6fbe211961ed881a8`。该摘要只保留固定状态、
本地验证候选和产物摘要，不保存远端正文、凭据、JWT、请求标识或绝对路径。完整门槛仍未满足，任务
不得归档、打 tag 或发布。

紧接着的短诊断未重现协议违规：三种措辞均在 JWT 与预检 HTTP `200` 后、首条流阶段收到
`connect_end_stream_resource_exhausted`，各自完成 2 次有界流重试后返回 `FC_REMOTE_UNAVAILABLE`，
没有工具调用或候选。该结果继续证明服务容量窗口是当前阻塞因素之一；它不替代十次保留查询、三种
措辞和 packed 入口的成功门槛。

## 2026-08-11 上游恢复子集与第二阶段容量恢复

继续对照 npm 发布的上游 `@sammysnake/fast-context-mcp@1.3.2`（npm `gitHead`
`069971f5002c1da837a76576573507b60765d912`）后，迁移了两类有界互操作逻辑：仅在
`[TOOL_CALLS]...[ARGS]` 信封内修正未加引号键和尾逗号；仅从截断 `restricted_exec` 回收平衡、
完整且类型受支持的 `command1` 至 `command4` 对象。未迁移 loose readfile/path 扫描、任意 prose
候选回收、远端 thinking 回放或原始响应输出。候选层仅允许从本轮成功执行的 `readfile`/`rg` 证据
补回遗漏的非测试实现，随后重新通过 PathGuard 读取和范围复核；公开投影以
`recovered_candidates` 计数，并固定报告 `truncated` 与 `implementation_candidate_recovered`。

第一次完整门槛在上述提示词和恢复子集后得到：source 保留查询命中 7/10、三种 source 措辞因两次
`FC_REMOTE_UNAVAILABLE` 未完成、packed 三种措辞命中 2/3；零 `FC_PROTOCOL_INVALID`、零伪
`complete`/空候选，无效静态 key 为 `FC_AUTH_REJECTED`。加入一次新 JWT 会话恢复后，第二次完整
门槛得到 source 保留查询目标命中 8/10（另有一次固定远端失败和一次非目标成功）、source 变体
2/2、packed 2/3；仍为零协议错误和零伪空成功。两次临时打包 SHA-256 分别为
`19c2b5f8a72592cedfe87623ecb2cb547c034f2da2e3ceadc7ff3af217a5412e` 与
`08ebff7c02e0a69c3f831a22668175438e7e9f88655ba142cf9cb5585e45e0b6`。

为覆盖剩余边界，客户端最终允许最多两次新 JWT 会话恢复；每次等待、JWT、预检和同一当前请求均
消费原始 30 秒总截止时间，不添加工具轮次或命令。确定性测试证明第三个会话仍
`resource_exhausted` 时固定失败。随后的三措辞冷却前诊断中，每次 JWT 与预检均为 HTTP `200`，
三个会话共九个 stream 也均为 HTTP `200`，但全部以结构合法的
`connect_end_stream_resource_exhausted` 终止，故 3/3 正确返回 `FC_REMOTE_UNAVAILABLE`。该批次只
记录固定状态、计数、本地相对范围和协议类别，不包含凭据、JWT、请求/响应正文或绝对路径。发布门槛
仍需在服务容量恢复后重跑并全部通过。

## 2026-08-11 多轮格式纠正诊断

加入本地证据择优、测试相对 import 恢复、截断 answer 字符串回收和一次 answer 形状纠正后，一次
完整正式门槛得到：source 保留查询 `9/10` 命中目标，source 三种措辞 `3/3` 命中，packed 三种
措辞 `3/3` 命中，零伪 `complete`/空候选，无效静态 key 为 `FC_AUTH_REJECTED` 且 stdout 为空。
唯一失败为 `FC_PROTOCOL_INVALID`；本批临时 packed tarball SHA-256 为
`882585ac5d66a9233729b39e28b02b69a536f351fdd30607e6b8c1824c99c851`。因此仍未达到发布门槛。

随后 `--diagnose-retained` 的十次独立调用精确复现一次同类失败。前九次均返回本地验证的
`src/ledger/repair.ts`；第十次 JWT、预检和四个 stream HTTP 状态均为 `200`，无容量或传输重试，
固定失败原因为 `tool_call_format_invalid`。脱敏协议事件显示第 2 个 executable 轮先使用一次信封
纠正并成功执行，第 3 轮再出现独立格式缺陷时直接失败。根因是一次纠正额度错误绑定到整个
executable 阶段，而不是一个逻辑远端请求。

修复将同一有界函数用于普通工具请求、终态 answer 请求和唯一一次 answer 内容纠正请求：每个逻辑
请求最多发送一次固定替代请求；替代不增加工具轮或命令，同一请求第二次格式错误仍失败关闭，所有
请求继续消费同一 30 秒 budget。确定性测试另覆盖两个 executable 请求分别纠正、answer 内容纠正
请求自身纠正以及同一请求第二次失败；未加入 prose/path 猜测或额外候选来源。

紧接十次诊断的下一批正式探针前四次均命中目标，之后连续五次
`FC_REMOTE_UNAVAILABLE`。该批已不可能满足 `10/10`，因此主动终止后续变体，避免继续占用远端
容量。已观察的九次中没有 `FC_PROTOCOL_INVALID` 或伪空成功；但容量失败仍使整批无效，必须在
独立冷却窗口重新执行完整正式门槛。

## 2026-08-11 冷却窗口的原版 MCP 标准入口复核

在 fork 单次探针持续返回 `FC_REMOTE_UNAVAILABLE` 后，使用 npm 发布的原版
`@sammysnake/fast-context-mcp@1.3.2` 标准 `src/server.mjs` stdio JSON-RPC 入口执行严格 A/B。
两次调用使用同一四文件夹具、同一保留查询，并通过 `env -u WINDSURF_API_KEY` 仅使用既有 WSL
Devin 自动发现；`FC_HIDE_EXTRACT_WINDSURF_KEY_TOOL=1` 保证凭据提取工具不可见。

两次 MCP 初始化、工具枚举和搜索工具调用均正常完成，搜索工具可见且凭据提取工具不可见；耗时分别
约 `1.45s` 和 `1.61s`。两次结果均为原版错误表面，第二次仅在进程内将原版输出映射为固定
`capacity_or_rate_limited` 类别；均无候选和本地有效范围。探针没有输出或保存原版错误正文、key、
JWT、请求标识、绝对路径或远端响应。

该 A/B 说明当前时点的容量或速率限制同时影响原版 MCP，不能归因于 fork 独有的 answer 协议路径，
也不能据此宣称原版实现存在缺陷。服务窗口恢复后应先交错执行一次原版 MCP 与一次 fork 单点探针；
两者均可用后才执行 fork 的 `10/10`、三种措辞、packed 入口和无效凭据完整发布门槛。

## 2026-08-11 Windsurf 官方额度与冷却机制调查

Windsurf 当前公开的[价格页](https://windsurf.com/pricing)明确说明付费计划具有 usage allowance，
并按每日和每周自动刷新；[Plans and Usage](https://docs.windsurf.com/windsurf/accounts/usage)
还说明旧 Enterprise credit 计划的 prompt credits 按月发放并在新 billing cycle 开始时重置，可选的
Automatic Credit Refills 会在余额低于 15 credits 时按配置补充。两份官方材料共同证明 Windsurf
存在用量额度和恢复窗口，但不同计划采用不同计量与恢复方式。

官方文档索引和账户 API 文档没有公开 `CheckUserMessageRateLimit`、`resource_exhausted`、
`Retry-After`、固定 cooldown 时长或可供该非公开语义检索接口读取的精确重置时间。调查时的
[官方状态 API](https://status.windsurf.com/api/v2/summary.json) 更新时间为
`2026-08-11T05:49:45.903Z`，整体为 `All Systems Operational`，`Cascade` 为 `operational`，
未解决事故为 0。因此，结合原版 MCP 同窗口返回的固定 `capacity_or_rate_limited`，当前证据支持
“账户、会话或内部容量门控窗口”，不支持“已知固定分钟数的全局冷却”。后续探针应使用指数退避和
低频交错 A/B，不根据猜测的分钟数循环调用；只有真实入口重新可用后才执行完整发布验收。

## 2026-08-11 `v0.1.6` 发布校验环境回归

用户明确接受外部真实 `10/10` 未重跑的残余风险并授权发布后，`v0.1.6` 在固定
`Node 26.5.1/npm 12.0.1` 的 NAS 完成工件构建、认证 preflight 和 tag 证据重建。GitHub Actions
run `31477461013` 随后在 `validate` 的 `npm test` 阶段以 108/109 失败，`publish` 按设计跳过，
npm registry 未写入该版本。

失败用例要求远端 answer 已有合法实现候选时不暴露无关 rg 探索命中，但测试让核心执行器自行寻找
宿主 rg。存在 `/usr/bin/rg` 的本机和 NAS 返回 `complete`；固定路径不可用的 runner 触发正确的
`local_tool_failure`，聚合状态为 `truncated`。纠正测试通过 `executorOptions` 注入绝对假 binary
与固定 rg JSON，并新增相对 binary 失败关闭回归。不可变 `v0.1.6` tag 保留为失败证据，后续发布
递增为 `0.1.7`；不得通过移动 tag 或重复运行宿主相关测试掩盖失败。
