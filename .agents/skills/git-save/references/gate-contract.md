# Git 提交门禁契约

## 固定流程

1. 暂存当前任务文件。
2. 执行 `node scripts/git-gate.mjs clear`。
3. 执行 `node scripts/git-gate.mjs prepare`，保存 `headCommit`、`stagedDiffHash` 和 `stagedWorkspace`。
4. 并行运行单元测试和质量检查；所有源码、配置和测试都从 `stagedWorkspace` 读取。
5. 每个检查器使用检查开始时的两个值调用 `write`；代码变化时脚本会拒绝写入。
6. 执行 `node scripts/git-gate.mjs verify`。
7. 展示提交方案，等待用户最终确认。
8. 正常执行 Git 提交，由 Hook 再次验证。
9. 提交成功由 `post-commit` 自动执行 `finish`；检查失败、取消或提交失败时由协调 agent 在退出前执行 `finish`。

## 写入命令

```powershell
node scripts/git-gate.mjs write --checker unit-test --verdict passed --expected-head <HEAD> --expected-hash <HASH> --commands-json '["npm.cmd run typecheck","npm.cmd test"]' --summary-json '{"conclusion":"passed","typecheckPassed":true,"testsPassed":true,"testsPassedCount":19}'
```

质量检查器使用相同格式，但 `--checker` 为 `quality`。失败时可以写入 `failed` 供报告使用，但失败凭证永远不能放行提交。

## 通过标准

- 单元测试：类型检查和完整自动化测试全部真实执行成功，未静默跳过失败测试。
- 质量检查：全项目没有已确认的严重问题，本次改动没有新增严重或高风险问题。
- “新增问题”以当前 `HEAD` 为历史基线：分别查看 `HEAD` 原版本和暂存快照；仅快照中新出现、等级升高或影响范围扩大的问题算新增。
- 两个检查器都必须确认检查期间的 HEAD 和暂存内容指纹没有变化。
- 凭证只在本机保存，有效期 60 分钟，不上传 GitHub。
- `finish` 只删除 `.codex/gate-worktree/` 和两张凭证；暂存区、工作目录和 Git 历史保持不变。

## 边界

门禁防止误提交未经检查的代码，但不是数字签名。Git 自带的 `--no-verify` 可以人为绕过 Hook，因此所有项目 agent 都必须禁止使用该参数。
