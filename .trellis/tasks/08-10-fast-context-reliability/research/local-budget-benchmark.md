# 本地资源预算基准

## 目的

为 Issue 046 保存可重复的小仓库规模与延迟基线，并证明宽目录、深目录及大量空目录会按 typed truncation 收敛。该基准只使用 `node:test` 临时目录，不读取真实仓库内容，不调用网络或 Windsurf。

## 复现入口

```bash
node --test test/path-guard.test.mjs test/executor.test.mjs
```

测试固定生成两类夹具：

- 小仓库：4 个源码目录、32 个普通文件；每轮新建一个 `ResourceBudget`，执行 3 次完整 `regularFiles()` 遍历并校验 visited 精确为 36 entries、5 directories、32 files。
- 大边界仓库：200 个宽目录文件、10 层深目录和 2,500 个空目录；分别使用 entries、depth 与 directories 的低测试上限，要求结果为 `truncated`，原因依次为 `entry_limit`、`depth_limit` 和 `directory_limit`。

## 2026-08-10 观测

- Node 测试进程中，小仓库三次遍历为 `11.0 ms`、`10.5 ms`、`10.9 ms`。
- 大边界夹具从宽目录检查开始到 2,500 空目录按目录预算停止共 `589 ms`。
- 测试门槛保守设为：小仓库单轮 `< 2,000 ms`，大边界组合 `< 5,000 ms`。门槛用于捕获数量级回退，不承诺不同文件系统上的绝对性能。

## 结果解释

这些数据证明正常小仓库在当前实现下没有明显性能回退，并证明大型无匹配 glob 不会无界运行。它们不代表生产硬件 SLA；可靠性契约由集中命名的资源计数和单调 deadline 保证。
