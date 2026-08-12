# multi-signal-sync extension 实现 + 验证（MECE 完整方案）

> openpi tasks 残留根治，MECE 五类完成信号。2026-08-12。
> **状态：PR #6（tt-a1i/openpi），A/B/C 信号验证通过。**

## 第一性原理
tasks 状态（in_progress/blocked → done）应由**真实完成信号**驱动，非 agent 记忆。

## MECE 五类完成信号

| 信号 | 完成事件 | 信号来源 | 触发机制 | 验证 |
|---|---|---|---|---|
| A commit | git commit exit 0 | tool_result | COMMIT_PATTERNS 检测 | ✅ |
| B verify | tsc/test/verify PASS | tool_result | VERIFY_PATTERNS 检测 | ✅ |
| C authorization | 业主授权/裁定 | context user message | AUTHORIZATION_PATTERNS 检测 | ✅ |
| D 无变更完成 | 分析/设计结论 | 无信号 | 收口审计纪律 | ✅ 设计 |
| E 取消/吸收 | dropped/superseded | 无信号 | 收口审计纪律（agent 决策）| ✅ 设计 |

## 演进（commit-task-sync → multi-signal-sync）

- **v1 commit-task-sync**：A commit 单信号，ui.notify（瞬时）
- **v2 commit-task-sync**：+ context injection（`<commit-task-sync>` 块，agent 不可忽略）
- **v3 multi-signal-sync**：MECE A/B/C 三信号（tool_result + context），dual-channel
- **v4 修复**：分离 signals（context 注入）vs pendingNotify（agent_settled notify）——context 注入 reset signals 导致 notify 不触发的 bug
- **v5 驻留**：notify → footer setStatus（Persistent Status Indicator，跨 render 驻留显示）

## 验证记录（2026-08-12）

### A commit（v2 commit-task-sync 验证）
- 用户确认 TUI notify「⚠️ git commit 检测到」
- agent 确认 `<commit-task-sync>` 块注入（context injection）

### B verify + C authorization（v4 multi-signal-sync 验证）
- 用户发「授权」→ context 检测 → authorization 信号
- **用户确认 notify「检测到完成信号（commit + 验证通过 + 业主授权）」—— A/B/C 三信号同时触发**

### v5 驻留（footer setStatus）
- 瞬时 notify → footer setStatus（`ctx.ui.setStatus("multi-signal-sync", ...)`）
- 跨 render 驻留显示（tui.md Pattern 4: Persistent Status Indicator）
- 下轮无新信号清除（`setStatus(undefined)`）
- **待重启加载验证 footer 驻留**

## 关键机制发现（openpi）

| 发现 | 意义 |
|---|---|
| `pi.on("tool_result")` | PostToolUse 等价（检测工具成功）|
| `pi.on("context")` return { messages } | context injection（注入 agent 上下文）|
| `ctx.ui.setStatus(ext, text)` | footer 驻留状态（跨 render，非瞬时 notify）|
| `emitter.on(channel, safeHandler)` | EventEmitter 多 handler（多 extension 不冲突）|
| `ctx.ui.setWidget(key, ...)` | 驻留面板（tasks 的 session-tasks-panel）|

## PR
- **tt-a1i/openpi#6**（feat/commit-task-sync，含 multi-signal-sync v5）
- fork: agnitum2009/openpi → tt-a1i/openpi

## 结论
tasks 残留从「靠 agent 记忆力（4 次复发）」变「**机制强制提醒（MECE 三信号：commit/验证/授权）+ 驻留显示（footer setStatus）+ context 注入（agent 不可忽略）**」。
