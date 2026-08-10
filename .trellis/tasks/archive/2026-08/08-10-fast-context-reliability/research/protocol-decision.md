# Connect 与 Node 官方资料决策

## 官方资料

- Connect Protocol Reference：<https://connectrpc.com/docs/protocol/>
- Node.js `zlib`：<https://nodejs.org/api/zlib.html>
- Node.js Web Streams：<https://nodejs.org/api/webstreams.html>
- Node.js child process：<https://nodejs.org/api/child_process.html>

检索只使用上述官方一手资料，没有使用第三方教程或真实远端服务。

## 协议事实

- Connect streaming envelope 是 1 字节 flags、4 字节 big-endian unsigned message length 和恰好对应长度的 message。
- 最低位表示按 `connect-content-encoding` 压缩；未协商或 identity 时该位必须为 0，压缩上下文不能跨消息维持。
- 次低位表示 `EndStreamResponse`；响应流必须在最后一帧设置该位，之前所有帧不得设置。该位与压缩位独立，因此 negotiated encoding 为 gzip 时 `0x03` 是需要严格解压和校验的合法组合。
- streaming 响应至少一帧，必须以 EndStream 结束。成功 EndStream 可为 `{}`；失败 EndStream 必须含合法 `error`，客户端不能把它解释为成功候选。
- 其余 6 个 flags 位为未来扩展保留；本组件没有协商扩展，因此必须拒绝。
- Node `zlib` convenience methods 从远早于 Node 20 的版本即支持 `maxOutputLength`，可直接限制 `gunzipSync` 输出；截断 gzip 会报错。
- Node 异步 `execFile` 支持 `AbortSignal`，且默认不启用 shell；子进程完成应以 `close` 事件为最终确认。

## 采用严格最小 decoder

本组件不引入成熟 Connect 客户端，保留并严格化最小 decoder，理由如下：

1. 当前 package 无运行时依赖，只使用固定 protobuf 编码和一个 streaming RPC；完整客户端需要 transport、schema 生成或额外适配。
2. package `files` 是安全 allowlist，新增依赖/生成资产会扩大 provenance、离线安装和发布验证面。
3. 当前缺陷集中在 envelope 状态机与资源上限，官方协议对所需行为定义完整，可用小型离线矩阵穷举失败边界。
4. 本决策不手写通用 Connect 客户端，只实现当前协议子集；任何未知 flags、编码或结构均失败关闭。

若未来增加多个 RPC、双向流、metadata 或完整错误细节消费，应另立任务评估官方 Connect 客户端。本任务不做该产品扩张。
