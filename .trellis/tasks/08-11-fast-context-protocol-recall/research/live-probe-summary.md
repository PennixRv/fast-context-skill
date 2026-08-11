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
