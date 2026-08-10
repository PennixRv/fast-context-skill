# 上游凭据发现对照

## 已核验来源

公开 GitHub 一手资料显示，`SammySnake-d/fast-context-mcp` 的 `getApiKey()` 先使用 `WINDSURF_API_KEY`，再调用 `extractKey()`；其 Issue 15 记录 WSL 内 Windows key 失败而建议在 WSL 运行 Devin 登录。该项目的 PR 23（修复 Issue 22）将自动发现的接受条件从仅 `sk-` 放宽为任何非空值，专门支持 `devin-session-token$...`。

`oulkurt/fast-context-skill` 的 PR 1 则将发现接受条件扩展为 `sk-` 或 `devin-` 前缀。该上游 Skill 仍导入完整 `extract-key.mjs`。

## fork 缺口

当前组件只保留受限搜索核心、`PathGuard` 和公开错误包装。其 CLI 在核心动态导入前只读取显式 `WINDSURF_API_KEY`，不含 `extract-key.mjs`、Devin CLI TOML 路径或 `devin-`/Devin session token 兼容逻辑。因此 WSL Devin 已登录而无显式环境变量时必然失败。

## 采用与拒绝

原始 MCP 的提取器会枚举 Linux/macOS/Windows 的 Devin、Deviv、Windsurf 桌面 `state.vscdb`，并会在返回对象中携带探测路径、错误和提示。它也可读取 Linux `~/.local/share/devin/credentials.toml`。本组件只采用后者的已验证 WSL/Linux 路径概念，不复制桌面 SQLite、多路径扫描、路径诊断或宽松任意 token 回退。

实现采用项目随包发布的受控 Node 子进程：仅 Linux、仅固定 Devin CLI 路径、常量大小上限、普通文件/非符号链接检查、精确字段、有限 token 格式、无 stderr 传播。父进程只从私有 stdout 管道取得合格值并立即传给本次 `search()`。这比直接在 CLI 进程读取本机凭据或复用桌面扫描更容易审计，也保持无凭据时失败关闭。
