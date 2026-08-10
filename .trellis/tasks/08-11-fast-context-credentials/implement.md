# 实施计划：凭据发现与远端错误分类

## 顺序与检查点

1. 完成证据和上游研究，确认 fork 缺少 `extract-key.mjs`、Devin CLI TOML 路径和 `devin-` 前缀支持；记录不采用桌面 SQLite 扫描的安全理由。
2. 激活 Trellis 任务，读取 CLI 安全契约、共享思考指南及任务研究，再开始源码修改。
3. 新增最小凭据模块和随包辅助脚本：静态环境优先、Linux 固定 Devin 文件、无 shell/短时限/输出上限、无日志/无路径输出、精确字段和 token 格式校验。
4. 更新 CLI 参数解析与 `runCli()` 依赖注入，增加 `--no-external` 并确保其先于凭据访问和核心导入。
5. 在核心 HTTP 边界引入稳定的 401/403、超时、网络、5xx 和协议分类；确保非成功响应不读取正文。
6. 扩展凭据、CLI、核心与打包安装测试，使用合成 token、受控子进程 fixture 和注入 fetch；不使用真实 token。
7. 更新 CLI 契约、安全 spec、README/SKILL 及 provenance/package allowlist；增加运行文件的 Node 语法检查。
8. 运行完整质量门槛和 WSL Devin 有界真实探针。探针只保留退出状态、结果状态和候选计数。
9. 使用 `trellis-check` 执行全范围复核，使用 `trellis-update-spec` 将已改变的凭据/错误契约写入 spec；修复发现的问题后重复验证。
10. 提交清晰源码变更。若所有本地、远程预检和质量门槛通过，按已验证的 C/E/注释 tag/GitHub Actions/注册表回验路线发布补丁版本；不使用本地 `npm publish`。

## 验证清单

- `npm test`
- `npm run verify:provenance`
- `npm run pack:check`
- `npm pack --dry-run --json --ignore-scripts`
- `node --check` 覆盖新增及修改的 `.mjs`
- 打包后的 CLI：`--help`、`--no-external`、合成鉴权错误与包内容入口
- WSL：移除 `WINDSURF_API_KEY` 的 Devin 登录态有界真实探针，不输出凭据或正文
- `python3 ./.trellis/scripts/task.py validate 08-11-fast-context-credentials`
- `trellis update --dry-run`
- `git diff --check`

## 回滚条件

- 发现辅助脚本无法把凭据限制在固定 Linux 路径、会把值写入持久状态或必须读取桌面数据库时，撤回自动发现实现并保留研究证据。
- 任何公开输出含 token、路径、响应正文、认证头、请求 ID 或底层异常时，停止发布并先修复红action。
- C/E/tag 证明链、远程 npm 预检或 GitHub Actions 发布/注册表摘要回验任一失败时，不重试发布，不重写 tag；保留失败证据并报告。
