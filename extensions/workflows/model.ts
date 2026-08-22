/**
 * Shared workflow run model + formatting helpers, used by the tool renderers
 * (index.ts) and the /workflows dashboard (dashboard.ts).
 */

import * as os from "node:os";
import {
  truncateHead,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import { spinnerFrame } from "../shared/spinner.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import type { WorktreeCleanup } from "../shared/worktree.ts";
import type { AcceptanceLedger } from "./acceptance.ts";
import {
  projectWorkflowGraph,
  type WorkflowGraphProjection,
  type WorkflowGraphRecord,
} from "./graph-projection.ts";
import type { InvocationRecord } from "./invocation-ledger.ts";
import { safeStringify } from "./serialization.ts";

export type Theme = ExtensionContext["ui"]["theme"];

export const RESULT_JSON_MAX_BYTES = 24 * 1024;
export const RESULT_JSON_MAX_LINES = 600;

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Latest compaction-aware conversation occupancy, not cumulative billing. */
  contextTokens?: number;
  turns: number;
}

export function emptyUsage(): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

export type AgentState = "running" | "done" | "error";
export type WorkflowStatus = "running" | "completed" | "failed" | "aborted";

export type TranscriptRole =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "toolResult";

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  /** Tool name for tool calls/results. */
  name?: string;
  /** Stable tool-call identifier used to pair calls, results, and timings. */
  toolCallId?: string;
  isError?: boolean;
  /** Original message timestamp, when provided by the model/session. */
  timestamp?: number;
  /** Tool execution lifecycle timestamps, measured by the child session. */
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentRecord {
  index: number;
  /** Stable identity and independent intent/admission/execution status planes. */
  callId?: string;
  invocation?: InvocationRecord;
  /** Ephemeral same-run child Session reused for this logical operator. */
  operatorKey?: string;
  /** Explicit result-reference dependencies used by the derived graph. */
  inputCallIds?: string[];
  /** Opaque same-run reference returned to the workflow script. */
  resultRef?: string;
  label: string;
  phase?: string;
  state: AgentState;
  model?: string;
  /** Context capacity of the active model used for this agent. */
  contextWindow?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  preview: string;
  usage: AgentUsage;
  /** Replayed from a prior run's journal instead of actually executed. */
  replayed?: boolean;
  /** Explicit caller-supplied acceptance result; never inferred from role/task. */
  acceptance?: AcceptanceLedger;
  /** Branch of the isolated worktree this agent ran in, when it holds commits. */
  worktreeBranch?: string;
  /** Isolated worktree kept on disk because automatic cleanup was unsafe. */
  worktreePath?: string;
  /** Authoritative result of inspecting and reclaiming the isolated checkout. */
  worktreeCleanup?: WorktreeCleanup;
  /** Run-directory-relative manifest captured before cleanup. */
  worktreeHandoffArtifact?: string;
  /** Normalized, serializable subagent conversation shown by /workflows. */
  transcript: TranscriptEntry[];
}

/** One narrator line emitted by the script's `log()`. */
export interface WorkflowLogEntry {
  at: number;
  text: string;
}

export interface WorkflowDetails {
  runId: string;
  /** Pi session that launched this run. */
  sessionId?: string;
  name?: string;
  description?: string;
  background: boolean;
  status: WorkflowStatus;
  startedAt: number;
  finishedAt?: number;
  phases: { title: string; detail?: string }[];
  currentPhase?: string;
  agents: AgentRecord[];
  /** Narrator lines from `log()`, oldest first, bounded to MAX_LOG_ENTRIES. */
  logs?: WorkflowLogEntry[];
  /** Oldest lines discarded once the ring filled, reported rather than hidden. */
  logsDropped?: number;
  result?: unknown;
  resultArtifact?: string;
  transcriptArtifact?: string;
  /** Run this one replayed cached agent results from, when resuming. */
  resumedFrom?: string;
  /** Why a requested resume produced no cache, for an honest result message. */
  resumeNote?: string;
  /** Read-only lineage projection; never execution or admission authority. */
  graph?: WorkflowGraphProjection;
  error?: string;
}

export function workflowGraphRecords(
  agents: readonly AgentRecord[],
): WorkflowGraphRecord[] {
  return agents.flatMap((agent) =>
    agent.callId
      ? [
          {
            callId: agent.callId,
            index: agent.index,
            label: agent.label,
            state: agent.state,
            ...(agent.invocation
              ? {
                  admissionState: agent.invocation.admissionState,
                  executionState: agent.invocation.executionState,
                }
              : {}),
            ...(agent.operatorKey ? { operatorKey: agent.operatorKey } : {}),
            ...(agent.inputCallIds
              ? { inputCallIds: [...agent.inputCallIds] }
              : {}),
            ...(agent.resultRef ? { resultRef: agent.resultRef } : {}),
          },
        ]
      : [],
  );
}

/** Refresh the descriptive graph without granting it scheduling authority. */
export function refreshWorkflowGraph(details: WorkflowDetails) {
  const records = workflowGraphRecords(details.agents);
  details.graph = projectWorkflowGraph(records);
  return details.graph;
}

export const MAX_LOG_ENTRIES = 100;
export const MAX_LOG_TEXT = 300;

/** Only generated workflow directory names may cross the artifact boundary. */
export function isWorkflowRunId(value: string): boolean {
  return /^wf_[0-9a-f]+$/i.test(value);
}

export function isWorkflowRunTarget(value: string): boolean {
  return isWorkflowRunId(value) || /^[0-9a-f]+$/i.test(value);
}

const RUN_RESOLUTION_MATCH_LIMIT = 8;

function boundedRunList(runIds: readonly string[]) {
  if (runIds.length === 0) return "none";
  const shown = runIds
    .slice(0, RUN_RESOLUTION_MATCH_LIMIT)
    .map((runId) => sanitizeLine(runId, 80));
  const omitted = runIds.length - shown.length;
  return `${shown.join(", ")}${omitted > 0 ? `, … (+${omitted} more)` : ""}`;
}

/** Resolve a generated id exactly, or a hex suffix only when it is unique. */
export function resolveWorkflowRunTarget(
  target: string,
  candidates: Iterable<string>,
) {
  const trimmed = target.trim();
  if (!isWorkflowRunTarget(trimmed)) {
    return {
      ok: false,
      error: "Workflow run id must be a generated id or hex suffix",
    } as const;
  }

  const normalizedTarget = trimmed.toLowerCase();
  const runIds = [...new Set([...candidates].filter(isWorkflowRunId))].sort();
  if (isWorkflowRunId(normalizedTarget) && runIds.includes(normalizedTarget)) {
    return { ok: true, runId: normalizedTarget } as const;
  }

  const matches = runIds.filter((runId) => runId.endsWith(normalizedTarget));
  if (matches.length === 1) return { ok: true, runId: matches[0]! } as const;

  const displayTarget = sanitizeLine(trimmed, 80);
  if (matches.length === 0) {
    return {
      ok: false,
      error: `No workflow run matching "${displayTarget}". Available: ${boundedRunList(runIds)}.`,
    } as const;
  }
  return {
    ok: false,
    error: `Workflow run suffix "${displayTarget}" is ambiguous. Matches: ${boundedRunList(matches)}. Use a longer suffix or full run id.`,
  } as const;
}

/**
 * Flatten model-authored text into one safe terminal line. Workflow scripts are
 * written by the model, so an escape sequence in a `log()` or `phase()` string
 * would otherwise repaint the user's screen; newlines would break row layout.
 */
export function sanitizeWorkflowDisplayText(
  value: string,
  maxLength = 16 * 1024,
): string {
  return [...sanitizeTerminalText(value)].slice(0, maxLength).join("");
}

export function sanitizeWorkflowDisplayLine(
  value: string,
  maxLength = 2_000,
): string {
  const line = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  return [...line].slice(0, maxLength).join("");
}

export function sanitizeLine(value: string, maxLength: number): string {
  // Code-point slicing, not code-unit: cutting a surrogate pair in half leaves
  // a lone surrogate that renders as a replacement glyph.
  const flat = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  const points = [...flat];
  const clipped =
    points.length > maxLength ? points.slice(0, maxLength).join("") : flat;
  return clipped.trimEnd();
}

/**
 * Append a narrator line, keeping only the most recent MAX_LOG_ENTRIES. The
 * tail is what a reader needs, and a silently dropped head would read as "the
 * script went quiet", so the discarded count is kept for the report.
 */
export function appendLog(
  details: WorkflowDetails,
  text: string,
  at: number,
): void {
  const clean = sanitizeLine(text, MAX_LOG_TEXT);
  if (!clean) return;
  const logs = (details.logs ??= []);
  logs.push({ at, text: clean });
  const excess = logs.length - MAX_LOG_ENTRIES;
  if (excess > 0) {
    logs.splice(0, excess);
    details.logsDropped = (details.logsDropped ?? 0) + excess;
  }
}

/** Cumulative token spend across a run's agents, as read by the script's `usage()`. */
export interface WorkflowUsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite. */
  total: number;
  cost: number;
  /** Agents started so far, including ones still running. */
  agents: number;
}

/**
 * Cumulative token spend for one run, as read by the script's `usage()`.
 *
 * Stateful because the underlying number is not monotonic: each agent's usage
 * is RECOMPUTED from its current message list, so when a child session
 * auto-compacts, the dropped messages take their tokens with them and the sum
 * falls. A script that loops `while (usage().total < N)` would then run well
 * past N — measured at 400k actual against a 250k intended stop — while
 * honestly reporting that it stopped on budget. A high-water mark cannot make
 * the reading exact, but it makes it an under-report that never reverses,
 * which is the property a loop condition needs.
 */
export function createUsageReader(agents: readonly AgentRecord[]) {
  let peak = 0;
  return (): WorkflowUsageSnapshot => {
    const usage = aggregateUsage([...agents]);
    const total =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    peak = Math.max(peak, total);
    return {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: peak,
      cost: usage.cost,
      agents: agents.length,
    };
  };
}

/**
 * One status indicator per state, shared by the transcript card, the
 * dashboard, and the strips. Running spins on the package-wide cadence so
 * every live view animates in step.
 */
export function stateGlyph(
  state: AgentState,
  theme: Theme,
  now: number,
): string {
  if (state === "done") return theme.fg("success", "✓");
  if (state === "error") return theme.fg("error", "✗");
  return theme.fg("warning", spinnerFrame(now));
}

export function statusGlyph(
  status: WorkflowStatus,
  theme: Theme,
  now: number,
): string {
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "running") return theme.fg("warning", spinnerFrame(now));
  return theme.fg("error", "✗");
}

export function statusWord(status: WorkflowStatus): string {
  return status === "completed" ? "done" : status;
}

export function statusColor(
  status: WorkflowStatus,
): "success" | "warning" | "error" {
  if (status === "completed") return "success";
  if (status === "running") return "warning";
  return "error";
}

export function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: AgentUsage, model?: string): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`${formatTokens(usage.input)} in`);
  if (usage.output) parts.push(`${formatTokens(usage.output)} out`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" · ");
}

/** Current per-agent context-window utilization, e.g. "7%/372k". */
export function agentContext(agent: AgentRecord): string {
  return formatContextUtilization({
    tokens: agent.usage.contextTokens,
    contextWindow: agent.contextWindow,
  });
}

export function formatElapsed(startedAt: number, finishedAt?: number): string {
  const totalSeconds = Math.max(
    0,
    Math.round(((finishedAt ?? Date.now()) - startedAt) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

export function aggregateUsage(agents: AgentRecord[]): AgentUsage {
  const total = emptyUsage();
  for (const agent of agents) {
    total.input += agent.usage.input;
    total.output += agent.usage.output;
    total.cacheRead += agent.usage.cacheRead;
    total.cacheWrite += agent.usage.cacheWrite;
    total.cost += agent.usage.cost;
    total.turns += agent.usage.turns;
  }
  return total;
}

export function countStates(details: WorkflowDetails) {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const agent of details.agents) {
    if (agent.state === "done") done++;
    else if (agent.state === "error") failed++;
    else running++;
  }
  return { done, failed, running };
}

export interface PhaseGroup {
  title: string;
  agents: AgentRecord[];
}

/**
 * Group agents by phase in declared phase order. With `includeEmpty`, phases
 * that have no agents yet are still listed (used by the dashboard sidebar).
 */
export function phaseGroups(
  details: WorkflowDetails,
  includeEmpty = false,
): PhaseGroup[] {
  const byPhase = new Map<string, AgentRecord[]>();
  for (const agent of details.agents) {
    const key = agent.phase ?? "(unphased)";
    const list = byPhase.get(key) ?? [];
    list.push(agent);
    byPhase.set(key, list);
  }
  const groups: PhaseGroup[] = [];
  for (const phase of details.phases) {
    const agents = byPhase.get(phase.title);
    if (agents || includeEmpty)
      groups.push({ title: phase.title, agents: agents ?? [] });
    byPhase.delete(phase.title);
  }
  for (const [title, agents] of byPhase) groups.push({ title, agents });
  return groups;
}

export function resultJson(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : safeStringify(value, {
          maxBytes: RESULT_JSON_MAX_BYTES * 2,
          maxDepth: 16,
          maxNodes: 10_000,
        });
  const truncation = truncateHead(text ?? "", {
    maxLines: RESULT_JSON_MAX_LINES,
    maxBytes: RESULT_JSON_MAX_BYTES,
  });
  return truncation.truncated
    ? `${truncation.content}\n…[result truncated; bounded result artifact in result.json]`
    : truncation.content;
}
