# openpi-dev 知识库

> openpi 本地开发库（clone from github.com/tt-a1i/openpi）。
> 目标：commit→tasks 自动同步 hook 尝试 + openpi 架构理解。

## 结构
- `architecture/` — openpi 整体架构（extension 系统 / pi.on 事件 / 工具注册）
- `extensions/` — 各 extension 分析（tasks / post-edit / plan-mode / sessions 等）
- `hook-design/` — commit→tasks hook 设计文档
- `tasks-mechanism/` — tasks 残留根因分析 + 机制改进
- `decisions/` — 开发决策记录

## 起因
批次二完成后 tasks 残留（4 次：T3/T1/T4/T6 状态没同步 commit 完成事实）。
根因：openpi tasks 无自动同步 hook（纯手动 tasks_update）→ 遗忘必然。
改进：commit→tasks hook（PostToolUse bash commit → tasks 残留提示）。
