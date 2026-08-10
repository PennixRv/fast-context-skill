# Trellis 0.6.14 更新裁决

## 更新结果

- 更新前项目版本：`0.6.10`
- 本机 CLI：`0.6.14`
- 命令：`trellis update --create-new`
- 自动更新 5 个未修改模板：
  - `.trellis/scripts/common/active_task.py`
  - `.trellis/scripts/common/git.py`
  - `.trellis/scripts/common/task_context.py`
  - `.trellis/scripts/common/session_context.py`
  - `.agents/skills/trellis-meta/references/local-architecture/bundled-skills.md`
- 安全备份：`.trellis/.backup-2026-08-10T06-18-09/`，在准备提交验证完成前保留。

## 10 个 sidecar 的逐项裁决

| sidecar | 判定 | 理由 |
| --- | --- | --- |
| `.agents/skills/trellis-channel/references/command-reference.md.new` | 拒绝 | 与现有文件无内容差异；不合并无效变更。 |
| `.agents/skills/trellis-meta/references/local-architecture/workspace-memory.md.new` | 拒绝 | 仅空白差异；按要求不合并。 |
| `.trellis/agents/implement.md.new` | 拒绝 | 会把 `provider: codex` 改为 `provider: claude`，违反组件 channel 运行定义。 |
| `.trellis/agents/check.md.new` | 拒绝 | 会把 `provider: codex` 改为 `provider: claude`，违反组件 channel 运行定义。 |
| `.trellis/config.yaml.new` | 拒绝 | 会移除 `codex.dispatch_mode: inline` 并改为原生 sub-agent 默认说明。 |
| `.trellis/workflow.md.new` | 拒绝 | 会把 planning/execute 路由改回原生 sub-agent 与必需 JSONL，弱化主会话实施和显式 channel 上下文。 |
| `AGENTS.md.new` | 拒绝 | 会删除 Codex inline、主会话唯一协调和 channel-only 委派声明，改为 optional native subagents。 |
| `.codex/hooks.json.new` | 拒绝 | 会新增 `SubagentStart` 并引用刻意删除的 `inject-subagent-context.py`。 |
| `.codex/config.toml.new` | 拒绝 | 会新增 `[agents] max_depth` 并改为原生 agent 语义；本项目不配置 native agents。 |
| `.codex/hooks/inject-workflow-state.py.new` | 拒绝 | 上游跨平台识别变化与当前 Codex 修复没有可验证必要性，且会把 inline banner 从“禁止 native Codex + 仅 channel”弱化为一般性不派发 implement/check sub-agents。 |

没有部分合并。全部 `*.new` 已清除，五个刻意删除资产继续不存在：

- `.codex/agents/trellis-check.toml`
- `.codex/agents/trellis-implement.toml`
- `.codex/agents/trellis-research.toml`
- `.codex/hooks/session-start.py`
- `.codex/hooks/inject-subagent-context.py`

## 收敛状态

- `.trellis/.version` 与 `trellis --version` 均为 `0.6.14`。
- `trellis update --dry-run` 不再提示版本升级；项目定制继续显示 `Modified by you` 是预期状态。
- `*.new` 数量为 0；安全备份仍存在。

