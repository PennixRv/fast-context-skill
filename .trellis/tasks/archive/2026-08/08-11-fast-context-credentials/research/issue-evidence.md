# 根 Issue 证据摘要

## Issue 056：鉴权拒绝被折叠

根仓库的受控真实对照表明，`fast-context-skill 0.1.4` 对同一静态密钥、有界项目和查询返回 `FC_REMOTE_UNAVAILABLE`；直接上游 Skill 与原始 `fast-context-mcp 1.3.2` 都报告 HTTP `401`。这证明请求已到达远端，不能把它归类为 DNS、TLS 或单纯超时。根 Issue 要求组件把 `401/403` 与网络、超时、`5xx`、协议失败区分为固定公开代码，且 stderr/JSON 不得包含密钥、长度、摘要、认证头、请求 ID 或远端正文。

本仓库复核确认原因：`scripts/lib/core.mjs` 的 `postBinary()` 将所有 `!response.ok` 归为 `FC_REMOTE_UNAVAILABLE`；CLI 再把未知异常同样归并。现有公开集合没有鉴权、超时或服务端专用类别。

## Issue 057：缺少 WSL Devin 登录态

根仓库已确认运行环境是 WSL，Devin CLI 登录状态存在；在移除 `WINDSURF_API_KEY` 后，原始 MCP 完成一次真实有界查询并返回候选，而本组件 `0.1.4` 在核心导入前直接返回 `FC_KEY_MISSING`。本仓库入口只读取 `environment.WINDSURF_API_KEY`，包内也没有上游的凭据提取实现，因而结论可重复。

根 Issue 要求的修复边界是：静态密钥、WSL/Linux Devin 自动发现和无凭据/主动禁用必须显式区分；不得把完整 token 放入命令、日志、任务、shell 配置或项目文件；npm 安装后的真实入口必须与源码一致。

## Issue 055 的关联边界

Issue 055 记录静态密钥真实请求的 HTTP `401`，同时明确 WSL Devin 自动发现已在原始 MCP 成功。该事实不证明静态密钥的服务端状态，也不授权组件关闭 Issue 055。本任务只交付新的安全错误分类和 Devin 登录态发现；根仓库仍需以已发布版本进行独立运行时验收。
