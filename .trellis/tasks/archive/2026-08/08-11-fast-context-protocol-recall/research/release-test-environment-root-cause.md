# Bug Analysis：发布测试隐式依赖宿主 rg

## 1. Root Cause Category

- **Category**：E - Implicit Assumption；次要为 D - Test Coverage Gap。
- **Specific Cause**：核心协议测试通过 `search()` 请求 `rg`，却没有注入固定 binary 与进程结果。测试在本机和 NAS 因存在固定 rg 路径而通过，在 GitHub runner 上则按产品契约失败关闭为 `truncated/local_tool_failure`。测试把宿主工具可用性误当成候选投影行为，导致同一提交跨环境结果不同。

## 2. Why Fixes Failed

1. 本机 `npm test`：运行时恰有 rg，不能区分“投影逻辑正确”和“环境依赖被满足”。
2. NAS 固定 Node/npm 预检：固定了打包工具版本，但宿主同样安装了 rg，因此重复了相同盲区。
3. 首次 GitHub 发布门：runner 缺少执行器认可的固定绝对 rg 路径，才提供了区分环境假设的证据；`publish` 正确跳过，未写 npm registry。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Test Coverage | `search()` 测试注入绝对假 rg binary 与固定 ripgrep JSON | DONE |
| P0 | Failure Boundary | 单独注入相对 binary，断言 `truncated/local_tool_failure` 且保留合法候选 | DONE |
| P0 | Release Integrity | 保留失败的不可变 `v0.1.6` tag，纠正版本递增为 `0.1.7` | DONE |
| P1 | Documentation | CLI spec 禁止成功路径测试继承宿主 rg，并定义失败 tag 的补丁升级规则 | DONE |
| P1 | Provenance | 更新 `core.mjs`、公共 provenance 与 `0.1.7` package identity | DONE |

## 4. Systematic Expansion

- **Similar Issues**：扫描 `test/core.test.mjs` 后，仅该用例通过 `search()` 请求真实 rg；executor 的进程测试已有固定 `rgBinary/runProcess` 注入，证据排序测试不启动子进程。
- **Design Improvement**：依赖注入只开放 `rgBinary` 与 `runProcess`，随后由 `search()` 强制覆盖共享 budget 和观察回调；远端模型、CLI 参数和环境变量都不能控制 executable。
- **Process Improvement**：发布前测试矩阵必须区分“固定 Node/npm”与“可选宿主工具”；成功路径使用离线夹具，工具缺失路径单独验证失败关闭。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/cli/fast-context-security.md` 的测试和发布契约。
- [x] 更新当前任务的 design、implement 与 live probe 研究。
- [x] 增加确定性成功与工具缺失回归。
- [x] 保持旧 tag，不重写发布历史。
