# commit-task-sync extension 实现 + 验证

> openpi tasks 残留根治尝试。2026-08-11/12。
> **状态：PR 已提交**（tt-a1i/openpi#6），双通道验证通过。

## 问题
openpi tasks（session 级跟踪）无自动同步——commit/reviewer/授权后 tasks_update 靠 agent 手动记忆 → 遗忘必然（4 次复发：批次一 T3 + 批次二 T1/T4/T6）。

## 演进：v1 → v2（dual-channel）

### v1：ui.notify（TUI 提示，建议性）
- `pi.on("tool_result")`：检测 bash `git commit` 成功 → 翻标志
- `pi.on("agent_settled")`：`ctx.ui.notify("⚠️ git commit 检测到")` TUI 警告
- **局限**：ui.notify 是建议性（agent 可能在对话中忽略 TUI 提示）

### v2：context injection（对话注入，强制）——增强
- 加 `pi.on("context")`：commit 检测后下轮注入 `<commit-task-sync>` 块到 messages
- **仿 `injectTaskProjection`**（tasks/index.ts:483 `pi.on("context") return { messages }`）
- **agent 不能忽略**（在对话上下文，不是 TUI 建议性）
- 注入后 reset（仅提醒一次/commit）

## 双通道设计（v2 最终形态）

| 通道 | 事件 | 效果 | 强度 |
|---|---|---|---|
| 1 ui.notify | `agent_settled` | TUI 警告（user 看到） | 建议性 |
| 2 context injection | `context` | `<commit-task-sync>` 块注入下轮 messages（agent 看到） | **强制** |

**为什么双通道**：ui.notify alone agent 可能忽略；context injection alone user 看不到。双通道 = user + agent 都不可忽略，无盲区。

## Pattern（遵循 openpi 既有 extension 规范）
- `pi.on("tool_result")`：hot path，boolean flag only（no await/exec）—— same as post-edit's MUTATING_TOOLS
- `pi.on("agent_settled")`：debounce commit burst → single notify —— same as post-edit
- `pi.on("context")`：inject reminder → reset flag（remind once per commit）—— same as injectTaskProjection
- Trust surface: detect `git commit` regex + `!event.isError`；不执行命令，不自动改 tasks（agent decides）
- TUI only for notify（headless RPC skipped，like post-edit）

## 验证记录（2026-08-12）

### tsc
- v1: `npx tsc -p tsconfig.json --noEmit` → exit 0（类型通过）
- v2: 初版 TS2769（pi.on("context") overload 不匹配显式 event 类型）→ 修复（去掉显式 event 类型，仿 tasks:483 推断）→ exit 0

### v1 ui.notify 验证 ✅
- pi 重启加载 commit-task-sync（settings.json `"../../work/openpi-dev"` extension path）
- 执行 `echo "git commit test"`（bash 含 git commit + exit 0）
- **user 确认 TUI 看到**：「⚠️ git commit 检测到 — 请检查 tasks 状态同步」

### v2 context injection 验证 ✅
- pi 重启加载 v2
- 执行 `echo "git commit context injection test"`（触发 tool_result → commitDetected=true）
- **agent 确认下轮上下文看到 `<commit-task-sync>` 块**（在 messages 里，agent 不能忽略）
- tasks_list 响应提醒 → 无 items（session 重启后空，无残留——正确）

## openpi hook 机制发现（本次调查关键）

| 发现 | 意义 |
|---|---|
| openpi **有 `pi.on("tool_result")`** | PostToolUse 等价（之前 rg `PostToolUse` 没命中因事件名不同）|
| openpi **有 `pi.on("context")`** | context injection 入口（`return { messages }` 替换上下文）|
| **post-edit extension** 是最佳 hook 范本 | tool_result 翻标志 + agent_settled 执行 + fire-and-forget |
| **injectTaskProjection**（tasks:483）是 context injection 范本 | `pi.on("context") return { messages }` |

## pi.on 可用事件清单（本次整理）
`tool_result` / `agent_settled` / `context` / `session_start/shutdown` / `model_select` / `agent_start` / `message_start/update/end` / `turn_end` / `session_compact` / `session_tree`

## PR
- **tt-a1i/openpi#6**：https://github.com/tt-a1i/openpi/pull/6
- fork: agnitum2009/openpi:feat/commit-task-sync → tt-a1i/openpi:main
- 等上游 review/merge

## 文件
- `extensions/commit-task-sync/index.ts`（5557B，dual-channel）
- `docs/knowledge-base/`（obsidian vault: 本文件 + residual-root-cause + design + README）

## 结论
tasks 残留从「靠 agent 记忆力（4 次复发）」变「**机制强制提醒**（commit → 下轮 context 注入 `<commit-task-sync>` 块，agent 不能忽略）」。机制补强（PostToolUse hook），不靠 agent 完美记忆。
