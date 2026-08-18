---
name: git-save
description: 为“可噜记账”检查 Git 提交范围和双重门禁凭证，在用户最终确认后创建本地 Git 存档点，并按用户当次选择决定是否推送 GitHub。用户要求安全存档、提交代码、保存版本、运行 gitcommit-agent 或在检查通过后提交时使用；不用于其他项目，也不绕过 pre-commit Hook。
---

# 可噜记账 Git 安全存档

只用于 `D:\A vibe coding\黑马记账app`。把 Git 提交视为可恢复的本地存档点，把推送视为另外一次会改变远程仓库的操作。

## 准备提交

1. 读取 `codex.md` 并执行 `git status --short`、`git diff`、`git diff --cached`。
2. 只选择当前任务相关文件。保留用户已有的无关改动；范围无法可靠判断时停止并向用户解释。
3. 将计划提交的文件暂存后，运行 `node scripts/git-gate.mjs prepare`，导出只包含暂存版本的隔离快照。
4. `gitcommit-agent` 调用本技能时，必须先完成两个检查 agent；不要用口头结论代替凭证。
5. 运行 `node scripts/git-gate.mjs verify`。任何错误都必须停止，不能使用 `--no-verify`。

完整凭证规则见 [references/gate-contract.md](references/gate-contract.md)。

## 最终确认

真正提交前，用通俗中文展示待提交文件和目的、单元测试结果、质量检查结论、中文提交说明，以及本次是“仅本地提交”还是“提交后推送 GitHub”。

必须得到用户本次明确确认后才能执行 `git commit`。以前同意安装门禁，不等于同意某一次具体提交。

## 创建存档与推送

1. 使用准确、简短的中文提交说明，不混入未暂存或未检查的文件。
2. 正常执行 `git commit -m "提交说明"`，让 `pre-commit` Hook 再次验证凭证。
3. 提交完成后检查 `git status --short` 和 `git log -1 --oneline`，报告提交编号。
4. 用户选择仅本地提交时，到此停止，不访问网络。
5. 用户选择提交并推送时，提交成功后执行 `git push`；推送失败时保留本地提交，并说明本地存档仍然存在。
6. 不使用 `--no-verify`、不改写历史、不强制推送、不自动删除未提交改动。
7. 成功提交后由 `post-commit` Hook 调用 `node scripts/git-gate.mjs finish`，删除本轮快照和凭证；该操作不得清空暂存区或删除代码。

## 失败处理

- 缺少或过期凭证：重新运行 `gitcommit-agent`，不要手工伪造凭证。
- 指纹变化：说明检查后代码发生变化，清理旧凭证并重新检查。
- 检查未通过：列出用户能理解的问题和修复方案，不擅自降低门槛。
- 检查失败、用户取消或提交命令失败：退出前调用 `node scripts/git-gate.mjs finish`，只清理快照和凭证，保留暂存内容与工作目录代码。
- Hook 配置缺失：由开发方修复本项目配置，不要求用户执行技术命令。
