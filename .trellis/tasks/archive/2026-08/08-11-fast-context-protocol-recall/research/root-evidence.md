# ROOT-ISSUE-058 受控证据摘要

## 修复基线

父仓库的旧 Gitlink 停在早期 detached 提交，不能作为实施起点。组件仓库远端 `origin/main` 为 `604d741056acbf1bf84bdc3a71dedff9aea2fdb3`，是 `v0.1.5` tag `15ee0415f576ce052f8369a7a3d5832c34e0620a` 的后代。两者 `package.json` 都声明 `0.1.5`，且 package allowlist 的运行时文件无差异；本任务据此实施。

已发布 `@pennixrv/fast-context-skill@0.1.5` 的受控记录 tarball SHA-256 为 `3c59b9c4eaa099812f886688ac90782a3048fc2053bc05d96617780ed35a09ae`。该值仅用来识别已发布基线，不代表本次候选的产物校验。

## 受控夹具与查询

夹具含四个 TypeScript 文件：

- `src/catalog/pricing.ts`
- `src/ledger/repair.ts`，其中 `repairOrphanedSettlements()` 从第 8 行开始，将 `half_applied` 记录恢复到 `posted`
- `src/notifications/dispatch.ts`
- `test/ledger-repair.test.ts`，相关测试从第 4 行开始

保留查询为“应用在中断批处理之后何处继续处理部分提交的财务记录”。查询不含目标路径、函数名、状态字面量或测试名；对夹具进行字面量本地搜索没有命中，适合验证未知代码位置检索而不是治理文档问答。

## 已观察结果

同一凭据和夹具下，原始 `fast-context-mcp v1.3.2` 连续四次返回 `src/ledger/repair.ts:1-24` 与 `test/ledger-repair.test.ts:1-11`。fork `0.1.5` 的十二个 HTTP 200 结构运行中，六次为 `FC_PROTOCOL_INVALID`，五次为 `complete`/零候选，一次非空结果未保留路径而无法验收。

结构探针进一步表明：

1. fork 的终态请求不再声明 `restricted_exec`，但远端仍可能调用该工具；fork 没有在最后有效工具结果后追加明确 force-answer 用户消息。
2. 远端曾发送 `test/ledger-repair.test.ts`，却没有 `<range>start-end</range>`；fork `parseAnswer()` 静默忽略，后续按本地覆盖率输出 `complete`/零候选。
3. fork 相比上游进行了大规模核心和提示词压缩。该差异是高风险信号，不作为未经验证的唯一根因。

## 安全结论

诊断、日志、测试和发布记录不得包含真实 key、JWT、完整远端响应、绝对项目路径或未验证候选。修复必须在本地严格校验后才公开相对路径和范围；禁止因提高召回而接受上游的自动 JSON 修复、prose 回收或越过 PathGuard 的路径。
