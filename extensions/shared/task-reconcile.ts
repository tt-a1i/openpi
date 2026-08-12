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

export function recordSettledSubagent(record: SettledSubagentRecord): void {
  settled.push(record);
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
