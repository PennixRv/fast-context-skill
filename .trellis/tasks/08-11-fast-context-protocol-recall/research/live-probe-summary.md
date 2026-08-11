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
