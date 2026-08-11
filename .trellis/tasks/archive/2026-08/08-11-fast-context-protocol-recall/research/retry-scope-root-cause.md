# 多轮格式纠正作用域根因分析

## 1. 根因类别

- **类别**：E（隐含假设）与 D（测试覆盖缺口）。
- **具体原因**：`MAX_TOOL_FORMAT_RETRIES = 1` 的数值上限正确，但实现把计数器绑定到整个可执行工具阶段。远端在第 2 轮得到一次格式纠正后，第 3 轮出现独立格式缺陷时已经没有纠正机会，最终返回固定 `tool_call_format_invalid`。协议的真实隔离单位是一个逻辑远端请求及其一次替代请求；格式纠正不会执行命令，也不应消耗后续工具轮或 answer 内容纠正请求的纠正额度。

## 2. 先前修复为何不完整

1. **分离 executable 与 answer-only 计数器**：解决了早期工具格式错误挤占最终 answer-only 纠正的问题，但仍把最多三个 executable 轮视为一个作用域。
2. **确定性 JSON 修复与完整命令回收**：覆盖未加引号键、尾逗号和截断对象等高频缺陷，但不能覆盖两个不同工具轮各自出现不可恢复信封的组合。
3. **单轮格式测试**：证明一次坏信封可纠正、同一阶段有上限，却没有组合两个不同 executable 轮，因此离线测试全绿时真实查询仍可偶发失败。

真实 `--diagnose-retained` 证据具有区分力：失败运行在 Connect/JWT/预检均为 HTTP 200、无流重试的情况下，于第 3 个 executable 轮得到 `tool_call_format_invalid`；事件显示第 2 轮已经使用过一次纠正。该证据排除凭据、Connect framing、容量和候选投影作为本次失败原因。

## 3. 防止复发

| 优先级 | 机制 | 具体动作 | 状态 |
| --- | --- | --- | --- |
| P0 | 架构 | 由一个函数为每个逻辑远端请求提供至多一次替代；替代请求不增加工具轮或命令 | DONE |
| P0 | 测试 | 固定响应序列覆盖两个 executable 轮分别坏一次并成功 | DONE |
| P0 | 测试 | 同一逻辑请求连续两个坏信封必须在第二次以 `FC_PROTOCOL_INVALID` 关闭 | DONE |
| P0 | 测试 | answer 内容纠正请求自身的首个坏信封可替代一次，且仍只暴露 `answer` | DONE |
| P1 | 规范 | 明确区分“每逻辑请求一次格式替代”“每 search 一次 answer 内容纠正”“每请求两次流重试”“每 search 两次会话刷新” | DONE |
| P1 | 诊断 | live probe 逐次输出脱敏的轮次、工具名、固定协议原因和 HTTP 状态 | DONE |

## 4. 系统性扩展

- **相似风险**：所有重试计数器必须以其保护的状态转换为作用域，而不是以方便声明变量的位置为作用域。
- **已审计边界**：`answerFormatRetries` 仍是每次 search 一次，因为它修正的是最终候选投影，不对应多个工具轮；`MAX_STREAM_RETRIES` 是每个不变请求两次；`MAX_SESSION_REFRESHES` 是整次 search 两次；三者均有确定性上限测试和共享 deadline。
- **设计改进**：纠正请求只替换当前坏响应，不写入本地工具结果、不增加 `turn`、不重置 `ResourceBudget`，因此提高互操作性而不扩大本地权限。
- **流程改进**：真实协议验收必须保留固定内部原因；只看公开 `FC_PROTOCOL_INVALID` 无法区分格式作用域、终态工具违规和 Connect 解码失败。

## 5. 知识固化

- [x] `.trellis/spec/cli/fast-context-security.md` 已更新为每协议轮一次格式纠正，并补充矩阵、测试和 Wrong/Correct 示例。
- [x] `test/core.test.mjs` 已覆盖多轮分别纠正与同轮第二次失败关闭。
- [x] `design.md` 和公开脚本契约已同步计数器作用域。
- [x] 当前组件没有 `src/templates/markdown/spec/` 或其他 spec 模板镜像，无需跨仓库同步。
