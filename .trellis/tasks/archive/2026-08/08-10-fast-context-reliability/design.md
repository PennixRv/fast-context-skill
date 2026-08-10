# 技术设计

## 设计目标

以最小且可验证的改动关闭五类可靠性缺口：先在网络边界限制实际读取与解压，再严格解释 Connect envelope；随后让本地搜索和子进程共享一次调用的资源预算；最后在同一 PathGuard 与预算内复核候选行范围。任何超限、取消或结构不一致都转为固定本地状态，不从远端正文构造用户可见语义。

## 架构边界

### 资源预算

新增一次 `search()` 独占的 `ResourceBudget`（名称可按代码风格调整），由集中常量构造：

- 使用单调时钟保存绝对 `deadline`，提供 `remainingMs()`、`throwIfExpired()` 和调用方取消检查。
- 维护 visited entries、directories、depth、files、matches 与 output bytes 计数。
- 产生统一 typed 结果：`complete` 表示在预算内穷尽，`truncated` 表示命中明确上限并携带计数/continuation，`failure` 表示取消、协议错误或不可恢复的本地执行失败。
- 所有阶段只接收同一个预算对象；网络和子进程 timeout 取 `remainingMs()`，不创建新的全额 timeout。

调用方取消与内部 deadline 合并为单一 AbortSignal。内部 AbortController 负责 deadline，外部 signal 触发同一取消路径；所有监听器在完成后移除。

### 响应读取

`postBinary` 不调用 `response.arrayBuffer()`。读取流程为：

1. 验证 HTTP 状态和可选 `Content-Length`。合法且已超过压缩响应上限时提前拒绝；缺失、非十进制、负数或与实际不符时仍以流式累计为准。
2. 使用 `Response.body.getReader()`（测试夹具也提供等价 Web `ReadableStream`）逐块读取。
3. 每块加入累计前检查整数与压缩字节上限；超限或取消时调用 reader cancellation，并等待读取路径收敛。
4. 将每块复制进单个固定压缩字节上限的 accumulator，完成后只返回已写入区间，避免 `arrayBuffer -> Buffer.from` 或 chunk list -> `Buffer.concat` 的整包复制链。

### Connect 严格最小 decoder

不引入成熟 Connect 客户端依赖。理由：组件当前无运行时依赖，只消费固定 protobuf 请求/响应与一条 server-streaming envelope；完整客户端会引入生成 schema、transport 和包 allowlist 迁移，超出缺陷修复面。官方协议已明确给出本任务所需的全部 framing 与 EndStream 规则，因此保留手写 decoder，但把它收敛为严格、可测试的最小状态机。

decoder 输入为有界 `Uint8Array`/`Buffer` 与 negotiated encoding，输出仅包含普通消息帧：

- 每轮先要求剩余字节至少 5 B；读取 unsigned flags 与 4 B big-endian unsigned length。
- 只允许最低两位形成的 `0x00` 到 `0x03`：普通/压缩普通 frame 与普通/压缩 EndStream。`0x03` 只有 negotiated encoding 为 `gzip` 且解压后的 EndStream JSON 合法时接受；6 个保留位一律拒绝。
- 检查声明长度不超过单帧压缩上限、不超过剩余输入，并用安全整数运算计算 frame end。
- 压缩位只有 negotiated encoding 为 `gzip` 时允许；identity 响应出现压缩位、gzip 协商下压缩状态不一致或 gzip 解压失败均拒绝。
- gzip 使用 `gunzipSync(..., { maxOutputLength })` 或等价接口，解压超限映射 `FC_OUTPUT_LIMIT`，格式错误映射 `FC_PROTOCOL_INVALID`，绝不 raw fallback。
- 每个解压 payload 检查单帧上限并累加整个响应解压上限。
- EndStream payload 按 UTF-8 JSON 严格解析；必须恰好一个、必须最后、成功时不得含 `error`，失败时不暴露远端 message。
- 输入必须被精确消费；任何残片、提前终止或 EndStream 后数据都失败关闭。

### 搜索枚举与 typed 结果

PathGuard 继续拥有 canonicalization、deny、symlink 与目录读取。遍历从同步“找到 N 个文件即返回数组”改为异步、预算感知的枚举结果：

```text
{
  status: "complete" | "truncated" | "failure",
  entries/files: [...],
  visited: { entries, directories, files },
  continuation: { pendingDirectories, lastPath } | null,
  limit: <本地固定原因或 null>
}
```

实现采用受控广度/深度遍历并稳定排序单层目录，避免字典序前 512 个文件被描述为完整集合。对 `rg`：每批只使用 PathGuard 已批准的显式文件 operand；若预算允许则继续分批，汇总匹配与 typed 状态；达到任何上限后保留 `truncated`，不得输出 `(no matches)` 作为完整结论。远端 tool result 与公开结果使用同一状态词和本地计数。

glob 仍通过 PathGuard 枚举结果筛选，`**/` 转换为“零个或多个目录段”，并受 100 结果、遍历与 elapsed 上限约束。deny 与 symlink 语义不变。

### 可取消子进程

将 `execFileSync` 替换为无 shell的 `execFile`/`spawn` 异步封装：

- 固定 `rg` binary、argv、cwd 与最小环境，保留现有参数语法白名单。
- 传入合并后的 AbortSignal 和预算剩余 timeout。
- 捕获 stdout 时逐块计数并执行硬输出上限；stderr 和底层异常不进入公开诊断。
- timeout/abort 后发送终止信号，并等待 `close`；若平台允许且普通终止未收敛，再使用有界的强制终止路径，最终确认 close 后才返回。
- 测试使用本地合成子进程记录 PID/退出事件，断言取消后进程不存在。

### 候选范围复核

`parseAnswer` 变为异步或在其前增加异步投影阶段，使范围验证可消费资源预算。每个候选执行：

1. 通过 PathGuard 解析并打开文件，拒绝 deny、根外、非普通文件和 symlink escape。
2. 在命名最大跨度内验证 start/end 正整数与顺序，不做 clamp。
3. 从同一打开文件句柄读取有界内容并统计真实逻辑行；空文件行数为 0，无尾换行的最后一行有效。
4. start/end 任一超过 EOF，或读取不到至少一行，丢弃候选。
5. 读取前后比较文件句柄 stat（大小、mtime、ino/dev 可用字段）；变化时丢弃，避免把范围声明绑定到不同文件版本。
6. 只返回本地固定 reason/status；远端 reason 不透传。

## 错误映射

- 响应压缩字节、frame 压缩/解压字节、累计解压或本地输出字节超限：`FC_OUTPUT_LIMIT`。
- Connect framing、flags、协商、gzip 格式、EndStream 或远端协议结构错误：`FC_PROTOCOL_INVALID`。
- 网络不可用、deadline 或调用方取消沿用现有固定网络/取消分类；若现有公开诊断没有独立取消类别，不增加会暴露内部信息的新文案。
- 本地路径和执行失败继续通过现有 `FastContextError` 固定诊断，不包含 path、body、key 或底层 message。

## 兼容性与文档

- Node 版本保持 `>=20`，只使用 Node 20 已支持的 Web Streams、AbortSignal、异步 child process 与 `zlib.maxOutputLength`。
- 不增加 npm 运行时依赖，不弱化 package allowlist 与 provenance/release 规则；实现完成后按既有证据链生成 `0.1.4` 发布工件，发布元数据只包含流程要求的机械更新。
- README 与 `references/script-contract.md` 更新 complete/truncated/failure、路径复核与范围复核边界；不声称语义正确性已由组件最终验证。

## 回滚点

- PREP_COMMIT 是独立基线，不与产品提交合并。
- 产品按 `047/048`、`045/046`、`049` 三个依赖阶段提交；任一阶段可独立回退，不撤销前序安全修复。
- 不执行数据迁移或全局安装；产品修复按阶段可回滚。补丁发布只在全量质量门槛通过后进行，发布失败按仓库既有流程停止，不修改父仓库补偿状态。
