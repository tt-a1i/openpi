/**
 * Subagent→task reconciliation bridge (omp's `#reconcileTodosWithSubagents`).
 *
 * The subagents extension records settled children here; the tasks extension
 * drains the records at `agent_settled` and auto-closes matching open tasks.
 * Completed children are the unblock signal even for blocked tasks; failed
 * children stay open so the user (or the next agent turn) decides what to do
 * — deliberately mirroring omp's design.
 */

export interface SettledSubagentRecord {
  id: string;
  /** Normalized title/description the tasks extension matches against. */
  description: string;
  /** Whether the child finished successfully. */
  ok: boolean;
}

let settled: SettledSubagentRecord[] = [];

/** Running-child descriptions, refreshed by the subagents extension. */
let runningDescriptions: string[] = [];

export function recordSettledSubagent(record: SettledSubagentRecord): void {
  settled.push(record);
}

/**
 * Publish the currently running children (omp's light-up source): the tasks
 * widget highlights a pending task whose subject matches a running child,
 * so "someone is already doing this" is visible before it completes.
 */
export function setRunningSubagentDescriptions(descriptions: string[]): void {
  runningDescriptions = descriptions;
}

export function getRunningSubagentDescriptions(): string[] {
  return runningDescriptions;
}

export function resetRunningSubagentDescriptions(): void {
  runningDescriptions = [];
}

/** Take and clear the records accumulated since the last drain. */
export function drainSettledSubagents(): SettledSubagentRecord[] {
  const records = settled;
  settled = [];
  return records;
}

export function resetSettledSubagents(): void {
  settled = [];
}
