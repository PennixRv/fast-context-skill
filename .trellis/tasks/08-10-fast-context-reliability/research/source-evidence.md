# 根审计证据摘要

## 只读证据范围

根仓库 `/home/penn/devel/codex-workflow-optimization` 的 Issue 045-050，以及归档任务 `08-10-fast-context-workflow-audit` 的 `audit-evidence.md` 与 `candidate-disposition.md`。这些文件只用于建立组件任务事实；组件会话不修改根仓库。

## 已确认复现

| Issue | 复现与事实 | 主要代码区域 |
| --- | --- | --- |
| 045 | 513 个字典序文件中目标位于第 513 个；`regularFiles()` 只返回 512 个，`rg` 得到 `(no matches)`。根目录与 `src/` 各有 `.mjs` 时，`**/*.mjs` 只命中子目录。 | `path-guard.mjs`、`executor.mjs` |
| 046 | 2,500 空目录使 `regularFiles` 与无匹配 glob 各访问 2,501 个目录；同步 `execFileSync` 每次可用 30 秒，4 命令 x 3 轮加网络的静态路径达 480 秒且遍历仍无硬上限。 | `path-guard.mjs`、`executor.mjs`、`core.mjs` |
| 047 | 32 MiB 重复字节可压缩为约 32 KiB Connect frame；当前 `arrayBuffer()` 先整包缓冲，`gunzipSync()` 可同步分配约 32 MiB，膨胀约 1,028 倍。 | `core.mjs`、`protobuf.mjs` |
| 048 | 帧头长度多报 100 B、压缩 flag 配未压缩 payload、未知 flag `4`、有效帧后 3 B 残头均可被接受；畸形响应仍可产生候选。 | `protobuf.mjs`、`core.mjs` |
| 049 | 2 行文件配 `999999-1000000` 远端范围会原样返回；当前只复核路径存在与 containment。 | `core.mjs` 结果投影、PathGuard |
| 050 | 组件项目为 Trellis `0.6.10` 而 CLI 为 `0.6.14`；更新必须保留 Codex inline 定制和刻意删除资产。 | `.trellis/`、`.codex/`、`AGENTS.md` |

所有审计实验都使用临时目录、合成 key 和注入响应，没有读取真实凭据或访问 Windsurf 服务。

## 契约冲突

- 有限文件清单目前静默改变 `rg` 搜索全集，却不报告截断。
- timeout 目前按步骤重置，目录遍历无统一 deadline 或调用方取消。
- README/spec 宣称请求、响应和协议错误有界且失败关闭，但响应先完整缓冲、gzip 无输出上限、frame decoder 接受结构不一致。
- “本地复核候选”目前只覆盖路径，不覆盖远端行范围。

## 依赖与处置

- 先修 047/048，因为所有远端结果都必须经过响应读取和 Connect decoder。
- 再修 045/046，因为搜索覆盖语义必须建立在同一资源预算和可取消子进程之上。
- 最后修 049，因为范围复核要复用稳定的 PathGuard 与预算。
- `.gitignore`/`--no-ignore`、中文 `search_terms`、`--max-results` 错误类别和 64 KiB 文件读取限制分别是增强或刻意限制，不进入本任务。

