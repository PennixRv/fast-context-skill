# 设计：凭据发现与远端错误分类

## 边界与目标

本任务只改变 CLI 的凭据选择边界、一个最小的 Devin 凭据辅助进程、远端 HTTP 状态映射及其测试/契约。`PathGuard`、`ResourceBudget`、Connect 解码和候选范围复核保持现有实现与调用顺序。

## 凭据来源

CLI 在 argv 与项目根校验完成后、搜索核心动态导入前解析凭据。来源优先级固定如下：

1. `WINDSURF_API_KEY` 是非空字符串时使用其去除首尾空白后的值，来源为 `environment`。
2. 没有显式密钥且平台为 Linux 时，启动项目随包发布的 Node 辅助脚本。辅助脚本自行根据其 home 目录构造唯一固定路径 `~/.local/share/devin/credentials.toml`；父进程不传入文件路径或凭据。
3. 未发现可接受的 Devin 值、子进程超时、异常退出、输出超限或非 Linux 平台时，返回 `FC_KEY_MISSING`。

`--no-external` 在任何凭据访问、辅助进程、核心导入或网络准备之前终止，返回 `FC_EXTERNAL_DISABLED`。它是调用方的主动禁用选择，不是无凭据的隐式替代。

辅助脚本只接受精确 TOML 字段中的已知 Devin/Windsurf 密钥形式，包括 `devin-session-token$...`、`devin-...` 和 `sk-...`。它拒绝符号链接、非普通文件、超限文件、未知字段和格式不合规的值。它使用 stdout 管道向父进程返回唯一的合格值，不写日志；父进程使用无 shell、受限环境、受限输出字节数和短时限的 `spawn`。父子进程均不将值纳入错误、结果、命令参数或持久文件。

不采用原始 MCP 的桌面 `state.vscdb` 多路径扫描：该方式扩大读取面、依赖 SQLite 解码并会在错误对象中携带路径和探测结果。固定 Linux Devin CLI 文件能覆盖已验证的 WSL 登录态，且满足本组件的最小权限原则。

## 公开错误矩阵

| 事件 | 公开代码 | 说明 |
| --- | --- | --- |
| 无显式密钥且安全发现失败 | `FC_KEY_MISSING` | 不暴露路径或发现细节 |
| 调用方传入 `--no-external` | `FC_EXTERNAL_DISABLED` | 不读取任何凭据 |
| HTTP 401 或 403 | `FC_AUTH_REJECTED` | 不读取响应正文 |
| 共享请求时限结束 | `FC_REMOTE_TIMEOUT` | 取消流后返回固定诊断 |
| DNS、TLS、socket、fetch 或调用方取消 | `FC_REMOTE_UNAVAILABLE` | 不透传异常文本 |
| HTTP 5xx | `FC_REMOTE_SERVER_ERROR` | 不输出状态、正文或请求 ID |
| Connect/JWT 响应格式不支持 | `FC_PROTOCOL_INVALID` | 保持既有失败关闭规则 |

非上述的 HTTP 非成功状态维持 `FC_REMOTE_UNAVAILABLE`。所有状态在 `postBinary()` 读取响应体之前判定，避免鉴权和服务端错误路径缓冲不可信正文。

## 数据流

```text
argv -> PathGuard -> --no-external gate -> credential resolver
     -> explicit env | controlled Devin helper | FC_KEY_MISSING
     -> dynamic core import -> ResourceBudget -> postBinary status gate
     -> fixed FC_* or existing bounded protocol/search result
```

凭据来源只影响传入 `search()` 的局部 `apiKey` 值，不改变请求体结构、JWT 获取、远端工具结果或公开成功 JSON。`runCli()` 接收可注入的 resolver，搜索核心继续接收字符串密钥，便于离线测试不依赖真实登录态。

## 兼容、回滚与发布

显式静态密钥继续优先，原有调用不需参数修改。新标志仅增加一个可见、失败关闭的调用方选择。若自动发现不适配某环境，用户可设置显式密钥或使用 `--no-external`，代码不会扫描其他系统路径。

运行文件变化会同时更新 `package.json.files`、包内容测试、来源/provenance 记录、CLI 契约与安全 spec。版本按补丁号发布，仍严格执行 C（源码和受跟踪 tarball）到 E（仅 attestation）再到注释 tag 的流程；发布在 GitHub Actions 中进行，并以注册表 exact tarball SHA-256 回验。
