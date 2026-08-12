# tasks 残留根因分析

## 现象
- 批次一 T3（刀6 申诉）：commit 264af92 + sa-1 复核，但漏标 done
- 批次二 T1（刀1）：note 更新但 status pending（半同步）
- 批次二 T4（刀4）：blocked→业主授权落码 2c933d9，但 T4 仍 blocked
- 批次二 T6（刀6）：blocked→ADR-0009 落地 b9a9341，但 T6 仍 blocked

## 根因（双重）
1. **遗忘（直接）**：commit/reviewer/授权后没 tasks_update
2. **机制不全（根本）**：openpi tasks 无自动同步 hook → 遗忘必然 + 无兜底

## 机制缺口（5 点）
1. 无 commit→tasks 自动同步 hook
2. 无 tasks 使用规范文档
3. session 级不持久（compaction 重置）
4. batch 关闭清空不可追溯
5. 无完成证据约束（status 转换无 commit SHA 强制）

## 改进方向
commit→tasks hook（仿 post-edit extension，agent_settled 检测 git commit → 残留提示）
