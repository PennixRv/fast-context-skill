# 上游 v1.3.2 协议对照

## 资料范围

对照原始 `SammySnake-d/fast-context-mcp` 的公开 `v1.3.2` `src/shared.mjs` 与 `src/core.mjs`，并与本仓库 `scripts/lib/core.mjs` 的 `0.1.5` 打包实现比对。仅将上游视为互操作性证据，不继承其安全边界较弱的处理。

## 差异

| 维度 | 上游 v1.3.2 | fork 0.1.5 | 本任务选择 |
| --- | --- | --- | --- |
| 终态策略 | 最后有效工具回合后追加 `You have no turns left... final ANSWER` 用户消息 | 仅从终态工具定义中移除 `restricted_exec` | 恢复显式 force-answer，且终态定义仍只含 `answer` |
| 请求预检 | JWT 后调用 `CheckUserMessageRateLimit`，固定 `MODEL_SWE_1_6_FAST`，再构建仓库地图和流请求 | 缺少该实际协议步骤 | 恢复有界 gzip 预检；使用当前安全 metadata 和共享 deadline，拒绝时失败关闭 |
| 容量重试与请求头 | 对 `429` 有界重试；无 `X-Request-Id`，另有 Sentry 追踪与 TLS 降级 | 无固定容量重试，额外发送 `X-Request-Id` | 删除额外请求标识；仅对固定容量/可用性类别有界重发同一请求，不恢复追踪、TLS 降级或任意重试 |
| 系统提示词 | 详细说明受限工具、调用例子、逐步推理、严格 XML、空 `<ANSWER>`、结果数 | 压缩提示词把工具信封限制为首字符且禁止推理，偏离上游模型对话形状 | 恢复最小协议例子、逐步推理、精确无结果标记和结果上限；信封前文本只在单次解析中丢弃，绝不回放或输出 |
| 工具调用解析 | 使用 JSON 修复及 `restricted_exec` 参数回收 | 只接受完整、有界 JSON，并仅允许一次格式重试 | 迁移信封内未加引号键/尾逗号修复和完整已声明命令回收；不迁移 loose path/prose 扫描，恢复后仍走原执行边界 |
| 最终答案解析 | 忽略不安全路径，保留同一文件的多个 ranges；支持响应/会话证据回收 | 对无范围、拒绝路径、无效范围静默跳过，且每文件只取首个 range | 支持同一文件多个精确 range，并逐项本地复核；最终遗漏已执行实现证据时只从本轮本地工具结果补回并标记 `truncated`，不扫描响应 prose |
| 范围锚定 | `readfile` 的编号行可供模型自行引用，最终 parser 不做本地 EOF/版本复核 | 只要求远端 range 通过严格本地复核，模型仍可能在终态估计范围 | 在受控 `readfile` 结果中附加非公开 `read_range`，终态和一次修正提示要求复用它；仍以本地同版本范围复核为唯一接受条件 |
| 无结果语义 | 空 `<ANSWER></ANSWER>` | 无文件标签即视为完整零候选 | 接受精确 `<no_results/>` 与既有空 `<ANSWER></ANSWER>`；其他无候选格式为协议无效 |
| 固定 Connect 字段 | JWT、预检与流请求均使用完整 Connect Go `User-Agent`；流为 `Accept-Encoding: identity` | 流和预检已对齐，但 JWT 仍缩短为 `connect-go/1.18.1` | 三个请求阶段统一完整固定 `User-Agent`，流保留 `identity`；不恢复主机名、CPU、TLS 降级或 Sentry 追踪头 |
| 工具对话回放 | 把远端 `thinking` 原文写回 assistant message | 写入固定确认文本，不回传远端原文 | 保持固定本地确认与嵌套 tool args；不迁移远端 thinking 回放，避免把不可信文字送回协议或日志 |
| 失败输出 | 可带原始响应、绝对项目路径和上游异常文字 | 固定 `FC_*`，不输出原始正文 | 保持固定 `FC_*` 与无敏感诊断 |

## 选择理由

上游四次真实成功说明 force-answer、完整示例、逐步推理、同文件多范围和无结果规则值得恢复为最小兼容层；后续真实差分又确认未加引号键、尾逗号和截断工具对象是实际互操作边界。因而迁移 `repairJsonText` 及完整命令对象回收的安全子集，但不迁移 loose readfile/path 扫描、任意 prose 证据回收、远端 thinking 回放或原始响应输出。工具恢复仍经过固定 schema、PathGuard 与共享预算；候选补回只使用本轮已成功执行的本地证据并重新做范围复核。
