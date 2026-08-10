# Harden Fast Context credential discovery and remote error semantics

## 目标

收敛根仓库 Issue 056 与 Issue 057：在不降低 Fast Context 既有路径、协议、资源预算和发布安全契约的前提下，支持受控的 WSL/Linux Devin 登录态凭据发现，并将远端鉴权拒绝从网络、超时、服务端和协议失败中稳定区分。

## 需求

- 凭据来源按以下优先级工作：非空显式 `WINDSURF_API_KEY`、Linux/WSL Devin CLI 登录态、无可用凭据。显式密钥行为必须保持兼容。
- 自动发现仅允许固定的 Linux/WSL Devin CLI 凭据位置；不得扫描桌面 SQLite 状态库、猜测多个路径、读取任意调用方路径或回退到 Windows 凭据位置。
- 凭据读取必须置于受控 Node 子进程中；不得打印、记录、持久化、写入 shell 配置、放入命令参数、公开 JSON、异常或 Trellis 工件。父进程只能在内存中接收已验证的值以完成本次请求。
- 增加 `--no-external`。该显式选择不得读取环境、启动发现子进程、导入搜索核心或建立网络请求，并以固定公开诊断结束。
- HTTP `401` 和 `403` 映射为稳定鉴权拒绝；超时、网络/传输、`5xx` 与响应协议错误分别映射为不同的固定 `FC_*` 类别。任何公开失败均不得包含响应正文、认证头、请求 ID、路径、凭据、长度、摘要或底层异常文本。
- 增加离线源码、CLI 与安装后的 npm 包回归测试。测试需证明静态密钥优先、受控发现成功/缺失/无效、显式禁用、所有远端错误类别和包内真实入口一致。
- 使用不带 `WINDSURF_API_KEY` 的 WSL Devin 登录态，对受限项目和受限结果数执行一次真实核心探针；仅记录退出状态、固定状态和候选计数，不记录凭据、请求/响应正文或候选正文。
- 任务完成后按既有可复现 C/E/注释 tag/GitHub Actions 流程发布补丁版本；不在本机执行 `npm login` 或直接 `npm publish`，不推送父仓库，不关闭父仓库 Issue 055。

## 非目标

- 不修复或判定静态密钥 HTTP `401` 的服务端原因，不关闭根仓库 Issue 055。
- 不读取或修改 `/home/penn/.codex`、父仓库、其他组件仓库、真实凭据文件或 shell 初始化文件。
- 不引入任意凭据路径、桌面状态库扫描、远端正文透传、任意命令、cwd 默认或新全局依赖。
- 不改变 PathGuard、hard deny、额外 deny、canonical root、symlink escape、搜索预算、Connect 解码、候选范围复核、Node 版本下限或既有包 allowlist/provenance 规则，除非本任务的新增运行文件必须被显式纳入 allowlist。
- 不进行 npm 全局安装、npm publish、本地凭据登录、tag 重写或父仓库 Gitlink 更新。

## 验收标准

### Issue 056

- [x] 注入的 `401` 和 `403` 都稳定输出专用鉴权错误，且不再输出 `FC_REMOTE_UNAVAILABLE`。
- [x] 注入的网络失败、超时、`5xx` 和 malformed Connect 响应分别输出固定且不同于鉴权错误的安全分类。
- [x] CLI stderr、核心异常和打包安装入口均不泄露合成密钥、远端正文、认证头、请求 ID、路径或原始异常。

### Issue 057

- [x] 显式 `WINDSURF_API_KEY` 优先于 Devin 自动发现，且无显式密钥时只在 Linux/WSL 运行受控 Devin 发现。
- [x] 固定路径凭据可用时，发现结果能传递到搜索核心；缺失、无效、超时或非 Linux 平台均失败关闭为 `FC_KEY_MISSING`。
- [x] `--no-external` 不读取凭据、不导入核心、不启动网络，并输出稳定禁用诊断。
- [x] `env -u WINDSURF_API_KEY` 的 WSL Devin 登录态真实有界探针成功，或以可复现、无敏感信息的环境限制记录失败原因。

### 交付与发布

- [x] `npm test`、provenance、包内容、打包安装、Node 语法、Trellis 校验、Trellis dry-run 和 `git diff --check` 全部通过。
- [x] 包 allowlist 包含新增运行文件，来源记录与源码一致。
- [ ] 源码提交、补丁版本 C 提交、仅含 attestation 的 E 提交、注释 tag、GitHub Actions 发布及注册表 tarball 摘要均可验证。
