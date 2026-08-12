# commit→tasks hook 设计

## 范本
post-edit extension（`extensions/post-edit/index.ts`）：
- 监听 `agent_settled`（turn 结束 debounce）
- `MUTATING_TOOLS = Set(["write","edit"])` 检测工具成功
- tool_result 翻标志 → agent_settled 时 pi.exec（fire-and-forget）

## 设计
新 extension `commit-task-sync`：
1. 监听 `message_end`：检查 bash tool_result 含 `git commit` + exit 0 → 标志
2. 下轮 context injection：committedThisTurn + in_progress tasks → 提示
3. 最小侵入（提示 agent，不自动改 tasks）

## pi.on 可用事件
session_start/shutdown, model_select, agent_start/settled, message_start/update/end, turn_end, session_compact, session_tree

## 约束
- 不阻塞 tool pipeline（fire-and-forget，仿 post-edit）
- 不自动改 tasks（提示 agent 决策——agent 知道哪个 task 对应哪个 commit）
- 最小信任面（检测 commit 字符串，不执行任意命令）
