/**
 * /workflows dashboard: a full-screen overlay with a run list and a per-run
 * detail view (phases sidebar + agents panel), modeled after:
 *
 *   name                                             5/5 agents · 31m18s · done
 *   description
 *   ╭ Phases ────────────╮ ╭ Gather · 3 agents ──────────────────────────────╮
 *   │ ❯ ✓ Gather     3/3 │ │ ✓ CodeRabbit feedback   gpt-5 · 7%/372k  5m37s│
 *   │   ⠿ Verify     1/1 │ │ ⠿ Other bot feedback    gpt-5 · 9%/372k  4m43s│
 *   ╰────────────────────╯ ╰─────────────────────────────────────────────────╯
 *   up/down select · right enter · left back · s save report
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ExtensionContext,
  getAgentDir,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { contextPercent } from "../shared/context-utilization.ts";
import {
  panelFrame,
  type ScreenHint,
  screenTitleLine,
  hintLine as sharedHintLine,
} from "../shared/screen-chrome.ts";
import { spinnerFrame } from "../shared/spinner.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { isAcceptanceLedger } from "./acceptance.ts";
import { projectWorkflowGraph } from "./graph-projection.ts";
import {
  classifyInterruptedInvocation,
  decodeInvocationRecord,
} from "./invocation-ledger.ts";
import {
  type AgentRecord,
  type AgentUsage,
  agentContext,
  aggregateUsage,
  countStates,
  formatElapsed,
  formatUsage,
  isWorkflowRunId,
  MAX_LOG_TEXT,
  type PhaseGroup,
  phaseGroups,
  resolveWorkflowRunTarget,
  resultJson,
  sanitizeLine,
  shortenHome,
  stateGlyph,
  statusColor,
  statusGlyph,
  statusWord,
  type Theme,
  type TranscriptEntry,
  type WorkflowDetails,
  type WorkflowLogEntry,
  workflowGraphRecords,
} from "./model.ts";
import { writeFileAtomic } from "./serialization.ts";

const NOTICE_TTL_MS = 4000;
const MIN_HEIGHT = 10;
const TRANSCRIPT_SCROLL_STEP = 20;

function wrapSelection(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (index + delta + length) % length;
}

export interface RunEntry {
  runId: string;
  details: WorkflowDetails;
  live: boolean;
}

function runsDir(): string {
  return path.join(getAgentDir(), "workflows");
}

/** Every persisted run id on disk; empty when no runs directory exists. */
export function listPersistedRunIds(): string[] {
  try {
    return fs.readdirSync(runsDir()).filter(isWorkflowRunId);
  } catch {
    // No runs yet.
  }
  return [];
}

/** Hydrate the result/transcript side artifacts referenced by workflow.json. */
function hydrateRunArtifacts(runId: string, details: WorkflowDetails) {
  const runDir = path.join(runsDir(), runId);
  if (details.resultArtifact) {
    try {
      details.result = JSON.parse(
        fs.readFileSync(
          path.join(runDir, path.basename(details.resultArtifact)),
          "utf8",
        ),
      );
    } catch {
      // Keep the compact compatibility marker from workflow.json.
    }
  }
  if (details.transcriptArtifact) {
    try {
      const transcripts = JSON.parse(
        fs.readFileSync(
          path.join(runDir, path.basename(details.transcriptArtifact)),
          "utf8",
        ),
      ) as Record<string, unknown>;
      for (const agent of details.agents) {
        agent.transcript = normalizeTranscript(
          transcripts[String(agent.index)],
        );
      }
    } catch {
      // Older or partially written artifacts simply lack transcripts.
    }
  }
}

export interface ReadPersistedRunOptions {
  /** Hydrate result and transcript side artifacts referenced by workflow.json. */
  hydrateArtifacts?: boolean;
}

/**
 * The single read entry for a persisted workflow.json: parse, normalize
 * (including runs written by older tooling), and optionally hydrate the side
 * artifacts. Unreadable or invalid runs read as undefined. Stale "running"
 * reconciliation stays with callers so selection filters can run on the
 * recorded timestamps first (`recoverStaleWorkflowDetails`).
 */
export function readPersistedWorkflowDetails(
  runId: string,
  options: ReadPersistedRunOptions = {},
): WorkflowDetails | undefined {
  let details: WorkflowDetails | undefined;
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(runsDir(), runId, "workflow.json"), "utf8"),
    );
    details = normalizePersistedWorkflowDetails(runId, raw);
  } catch {
    return undefined;
  }
  if (!details) return undefined;
  if (options.hydrateArtifacts) hydrateRunArtifacts(runId, details);
  return details;
}

function isWorktreeCleanup(
  value: unknown,
): value is NonNullable<AgentRecord["worktreeCleanup"]> {
  if (!value || typeof value !== "object") return false;
  const cleanup = value as Record<string, unknown>;
  return (
    typeof cleanup.removed === "boolean" &&
    typeof cleanup.branchDeleted === "boolean" &&
    typeof cleanup.branch === "string" &&
    typeof cleanup.detached === "boolean"
  );
}

function normalizeUsage(value: unknown): AgentUsage {
  const raw = value && typeof value === "object" ? value : {};
  const record = raw as Record<string, unknown>;
  const number = (field: string) => {
    const candidate = record[field];
    return typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0
      ? candidate
      : 0;
  };
  return {
    input: number("input"),
    output: number("output"),
    cacheRead: number("cacheRead"),
    cacheWrite: number("cacheWrite"),
    cost: number("cost"),
    ...(number("contextTokens") > 0
      ? { contextTokens: number("contextTokens") }
      : {}),
    turns: number("turns"),
  };
}

function normalizeTranscript(value: unknown): TranscriptEntry[] {
  if (!Array.isArray(value)) return [];
  const transcript: TranscriptEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (
      entry.role !== "user" &&
      entry.role !== "assistant" &&
      entry.role !== "thinking" &&
      entry.role !== "tool" &&
      entry.role !== "toolResult"
    ) {
      continue;
    }
    if (typeof entry.text !== "string") continue;
    transcript.push({
      role: entry.role,
      text: sanitizeTerminalText(entry.text),
      name:
        typeof entry.name === "string"
          ? sanitizeLine(entry.name, 160) || undefined
          : undefined,
      isError: entry.isError === true,
      timestamp:
        typeof entry.timestamp === "number" ? entry.timestamp : undefined,
    });
  }
  return transcript;
}

/** Leniently normalize a workflow.json (including runs from older tooling). */
export function normalizePersistedWorkflowDetails(
  runId: string,
  raw: unknown,
): WorkflowDetails | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const meta = (record.meta ?? {}) as Record<string, unknown>;

  const rawAgents = Array.isArray(record.agents) ? record.agents : [];
  const startedAt = typeof record.startedAt === "number" ? record.startedAt : 0;
  const agents: AgentRecord[] = [];
  for (const item of rawAgents) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const state =
      a.state === "error" || a.state === "failed"
        ? "error"
        : a.state === "running"
          ? "running"
          : "done";
    const index = typeof a.index === "number" ? a.index : agents.length + 1;
    const decodedInvocation = decodeInvocationRecord(a.invocation);
    const invocation =
      decodedInvocation &&
      decodedInvocation.executionState !== "settled" &&
      decodedInvocation.executionState !== "uncertain"
        ? classifyInterruptedInvocation(
            decodedInvocation,
            Math.max(
              Date.now(),
              decodedInvocation.requestedAt,
              decodedInvocation.claimedAt ?? 0,
              decodedInvocation.runningAt ?? 0,
            ),
          )
        : decodedInvocation;
    agents.push({
      index,
      ...(typeof a.callId === "string" && a.callId
        ? { callId: sanitizeLine(a.callId, 256) }
        : {}),
      ...(invocation ? { invocation } : {}),
      ...(typeof a.operatorKey === "string" && a.operatorKey
        ? { operatorKey: sanitizeLine(a.operatorKey, 80) }
        : {}),
      ...(Array.isArray(a.inputCallIds)
        ? {
            inputCallIds: a.inputCallIds
              .filter((value): value is string => typeof value === "string")
              .slice(0, 64)
              .map((value) => sanitizeLine(value, 256)),
          }
        : {}),
      ...(typeof a.resultRef === "string" && a.resultRef
        ? { resultRef: sanitizeLine(a.resultRef, 256) }
        : {}),
      label:
        typeof a.label === "string"
          ? sanitizeLine(a.label, 160) || `agent-${index}`
          : `agent-${index}`,
      phase:
        typeof a.phase === "string"
          ? sanitizeLine(a.phase, 160) || undefined
          : undefined,
      state,
      model:
        typeof a.model === "string"
          ? sanitizeLine(a.model, 240) || undefined
          : undefined,
      contextWindow:
        typeof a.contextWindow === "number" &&
        Number.isFinite(a.contextWindow) &&
        a.contextWindow > 0
          ? a.contextWindow
          : undefined,
      startedAt: typeof a.startedAt === "number" ? a.startedAt : startedAt,
      finishedAt: typeof a.finishedAt === "number" ? a.finishedAt : undefined,
      error:
        typeof a.error === "string" && a.error !== "[undefined]"
          ? sanitizeLine(a.error, 2_000) || undefined
          : undefined,
      preview:
        typeof a.preview === "string" ? sanitizeLine(a.preview, 4_000) : "",
      usage: normalizeUsage(a.usage),
      ...(a.replayed === true ? { replayed: true } : {}),
      ...(isAcceptanceLedger(a.acceptance) ? { acceptance: a.acceptance } : {}),
      ...(typeof a.worktreeBranch === "string"
        ? { worktreeBranch: a.worktreeBranch }
        : {}),
      ...(typeof a.worktreePath === "string"
        ? { worktreePath: a.worktreePath }
        : {}),
      ...(isWorktreeCleanup(a.worktreeCleanup)
        ? { worktreeCleanup: a.worktreeCleanup }
        : {}),
      ...(typeof a.worktreeHandoffArtifact === "string"
        ? { worktreeHandoffArtifact: a.worktreeHandoffArtifact }
        : {}),
      transcript: normalizeTranscript(a.transcript),
    });
  }

  const rawPhases = Array.isArray(record.phases)
    ? record.phases
    : Array.isArray(meta.phases)
      ? meta.phases
      : [];
  const phases: WorkflowDetails["phases"] = [];
  for (const item of rawPhases) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.title !== "string") continue;
    const title = sanitizeLine(p.title, 160);
    if (!title) continue;
    const detail =
      typeof p.detail === "string" ? sanitizeLine(p.detail, 2_000) : "";
    phases.push({ title, ...(detail ? { detail } : {}) });
  }

  const rawLogs = Array.isArray(record.logs) ? record.logs : [];
  const logs: WorkflowLogEntry[] = [];
  for (const item of rawLogs) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.text !== "string") continue;
    // Re-sanitized on the way in: this file was written by an earlier run and
    // is read back as untrusted data, not as something we just produced.
    logs.push({
      at: typeof entry.at === "number" ? entry.at : startedAt,
      text: sanitizeLine(entry.text, MAX_LOG_TEXT),
    });
  }

  const status =
    record.status === "running" ||
    record.status === "failed" ||
    record.status === "aborted"
      ? record.status
      : "completed";

  return {
    runId,
    sessionId:
      typeof record.sessionId === "string" ? record.sessionId : undefined,
    name:
      typeof record.name === "string"
        ? sanitizeLine(record.name, 160) || undefined
        : typeof meta.name === "string"
          ? sanitizeLine(meta.name, 160) || undefined
          : undefined,
    description:
      typeof record.description === "string"
        ? sanitizeLine(record.description, 2_000) || undefined
        : typeof meta.description === "string"
          ? sanitizeLine(meta.description, 2_000) || undefined
          : undefined,
    background: record.background === true,
    status,
    startedAt,
    finishedAt:
      typeof record.finishedAt === "number" ? record.finishedAt : undefined,
    phases,
    currentPhase:
      typeof record.currentPhase === "string"
        ? sanitizeLine(record.currentPhase, 160) || undefined
        : undefined,
    agents,
    ...(logs.length > 0 ? { logs } : {}),
    ...(typeof record.logsDropped === "number" && record.logsDropped > 0
      ? { logsDropped: record.logsDropped }
      : {}),
    ...(agents.some((agent) => agent.callId)
      ? {
          graph: projectWorkflowGraph(workflowGraphRecords(agents)),
        }
      : {}),
    result: record.result,
    resultArtifact:
      typeof record.resultArtifact === "string"
        ? record.resultArtifact
        : undefined,
    transcriptArtifact:
      typeof record.transcriptArtifact === "string"
        ? record.transcriptArtifact
        : undefined,
    resumedFrom:
      typeof record.resumedFrom === "string" ? record.resumedFrom : undefined,
    resumeNote:
      typeof record.resumeNote === "string" ? record.resumeNote : undefined,
    error:
      typeof record.error === "string"
        ? sanitizeLine(record.error, 2_000) || undefined
        : undefined,
  };
}

/** Reconcile durable facts from a run that has no live owner in this process. */
export function recoverStaleWorkflowDetails(
  details: WorkflowDetails,
  recoveredAt = Date.now(),
): WorkflowDetails {
  if (details.status !== "running") return details;
  details.status = "aborted";
  details.finishedAt = details.finishedAt ?? recoveredAt;
  details.error = details.error ?? "Recovered stale run that was not active";
  for (const agent of details.agents) {
    if (agent.state !== "running") continue;
    agent.state = "error";
    agent.error = agent.error ?? "Run ended before this agent settled";
    agent.finishedAt = details.finishedAt;
  }
  details.graph = projectWorkflowGraph(workflowGraphRecords(details.agents));
  return details;
}

export function sessionWorkflowRunIds(ctx: ExtensionContext): Set<string> {
  const runIds = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "workflow"
    ) {
      continue;
    }
    const details = entry.message.details;
    if (!details || typeof details !== "object") continue;
    const runId = (details as Record<string, unknown>).runId;
    if (typeof runId === "string") runIds.add(runId);
  }
  return runIds;
}

export function loadRunEntries(
  active: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
  /** Hide runs untouched by the current request; live runs always show. */
  startedSince = 0,
): RunEntry[] {
  const entries: RunEntry[] = [];
  for (const runId of listPersistedRunIds()) {
    const live = active.get(runId);
    if (live) {
      entries.push({ runId, details: live, live: true });
      continue;
    }
    const details = readPersistedWorkflowDetails(runId, {
      hydrateArtifacts: true,
    });
    if (!details) continue;
    const touchedAt = Math.max(details.startedAt, details.finishedAt ?? 0);
    if (
      touchedAt < startedSince ||
      (details.sessionId !== sessionId && !referencedRunIds.has(runId))
    ) {
      continue;
    }
    recoverStaleWorkflowDetails(details);
    entries.push({ runId, details, live: false });
  }
  return entries.sort((a, b) => b.details.startedAt - a.details.startedAt);
}

export function workflowGraphSummary(
  graph: NonNullable<WorkflowDetails["graph"]>,
) {
  const omitted = [
    graph.omitted.nodes > 0 ? `${graph.omitted.nodes} nodes` : undefined,
    graph.omitted.edges > 0 ? `${graph.omitted.edges} edges` : undefined,
    graph.omitted.diagnostics > 0
      ? `${graph.omitted.diagnostics} diagnostics`
      : undefined,
  ].filter(Boolean);
  return `${graph.nodes.length} nodes · ${graph.edges.length} edges${
    omitted.length > 0 ? ` · ${omitted.join(", ")} omitted` : ""
  }`;
}

export function buildWorkflowReport(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const lines: string[] = [
    `# Workflow ${details.name ?? details.runId}`,
    "",
    `- Run: ${details.runId}`,
    `- Status: ${statusWord(details.status)}`,
    `- Agents: ${done}/${details.agents.length} ok${failed ? `, ${failed} failed` : ""}`,
    `- Elapsed: ${formatElapsed(details.startedAt, details.finishedAt)}`,
  ];
  const totals = formatUsage(aggregateUsage(details.agents));
  if (totals) lines.push(`- Usage: ${totals}`);
  if (details.description) lines.push("", details.description);
  if (details.error) lines.push("", `**Error:** ${details.error}`);

  for (const group of phaseGroups(details, true)) {
    lines.push("", `## ${group.title}`, "");
    if (group.agents.length === 0) {
      lines.push("_no agents_");
      continue;
    }
    for (const agent of group.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      const stats = [
        agent.model,
        agentContext(agent),
        agent.acceptance ? `acceptance:${agent.acceptance.status}` : undefined,
        formatElapsed(agent.startedAt, agent.finishedAt),
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(
        `- **${agent.label}** — ${status}${stats ? ` (${stats})` : ""}`,
      );
      if (agent.error) lines.push(`  - error: ${agent.error}`);
    }
  }

  if (details.graph && details.graph.nodes.length > 0) {
    const labels = new Map(
      details.graph.nodes.map((node) => [node.callId, node.label] as const),
    );
    lines.push(
      "",
      "## Derived graph",
      "",
      `_observability only · ${workflowGraphSummary(details.graph)}_`,
    );
    for (const edge of details.graph.edges) {
      lines.push(
        `- ${labels.get(edge.source) ?? edge.source} → ${labels.get(edge.target) ?? edge.target}`,
      );
    }
    for (const diagnostic of details.graph.diagnostics) {
      lines.push(`- ⚠ ${diagnostic.code}: ${resultJson(diagnostic)}`);
    }
  }

  if (details.result !== undefined) {
    lines.push(
      "",
      "## Result",
      "",
      "```json",
      resultJson(details.result),
      "```",
    );
  }
  if (details.logs && details.logs.length > 0) {
    lines.push("", "## Log", "");
    if (details.logsDropped) {
      lines.push(`_${details.logsDropped} earlier line(s) dropped_`, "");
    }
    for (const entry of details.logs) lines.push(`- ${entry.text}`);
  }
  lines.push("");
  return lines.join("\n");
}

type View = "list" | "detail" | "transcript";
type DetailFocus = "phases" | "agents";

export class WorkflowDashboard {
  private view: View = "list";
  private entries: RunEntry[] = [];
  private listIndex = 0;
  private phaseIndex = 0;
  private agentIndex = 0;
  private detailFocus: DetailFocus = "phases";
  private transcriptScroll = 0;
  private transcriptRowCount = 0;
  private transcriptViewportSize = 1;
  private current?: RunEntry;
  private openedDirectly = false;
  private notice?: string;
  private noticeAt = 0;
  private disposed = false;
  private timer: ReturnType<typeof setInterval>;
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private getActive: () => Map<string, WorkflowDetails>;
  private sessionId: string;
  private referencedRunIds: ReadonlySet<string>;
  private startedSince: number;
  private close: () => void;
  private onAbort?: (runId: string) => boolean;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    getActive: () => Map<string, WorkflowDetails>,
    sessionId: string,
    referencedRunIds: ReadonlySet<string>,
    startedSince: number,
    close: () => void,
    initialRunId?: string,
    onAbort?: (runId: string) => boolean,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.getActive = getActive;
    this.sessionId = sessionId;
    this.referencedRunIds = referencedRunIds;
    this.startedSince = startedSince;
    this.close = close;
    this.onAbort = onAbort;
    this.refresh();
    if (initialRunId) {
      const resolution = resolveWorkflowRunTarget(
        initialRunId,
        this.entries.map((entry) => entry.runId),
      );
      if (resolution.ok) {
        const entry = this.entries.find(
          (candidate) => candidate.runId === resolution.runId,
        );
        if (entry) {
          this.listIndex = this.entries.indexOf(entry);
          this.enterEntry(entry, true);
        }
      } else {
        this.notice = resolution.error;
        this.noticeAt = Date.now();
      }
    }
    this.timer = setInterval(() => {
      if (
        this.entries.some((e) => e.live) ||
        this.current?.live ||
        this.notice
      ) {
        this.refresh();
        this.tui.requestRender();
      }
    }, 500);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
  }

  invalidate() {}

  private refresh() {
    const selected = this.entries[this.listIndex]?.runId;
    this.entries = loadRunEntries(
      this.getActive(),
      this.sessionId,
      this.referencedRunIds,
      this.startedSince,
    );
    if (selected) {
      const index = this.entries.findIndex((e) => e.runId === selected);
      if (index >= 0) this.listIndex = index;
    }
    this.listIndex = Math.min(
      this.listIndex,
      Math.max(0, this.entries.length - 1),
    );
    if (this.current) {
      const refreshed = this.entries.find(
        (e) => e.runId === this.current?.runId,
      );
      if (refreshed) this.current = refreshed;
    }
    if (this.notice && Date.now() - this.noticeAt > NOTICE_TTL_MS)
      this.notice = undefined;
  }

  private enterEntry(entry: RunEntry, directly: boolean) {
    this.current = entry;
    this.openedDirectly = directly;
    const groups = phaseGroups(entry.details, true);
    const currentPhase = groups.findIndex(
      (group) => group.title === entry.details.currentPhase,
    );
    this.phaseIndex = Math.max(0, currentPhase);
    this.agentIndex = 0;
    this.detailFocus = "phases";
    this.view = "detail";
  }

  private groups(): PhaseGroup[] {
    if (!this.current) return [];
    return phaseGroups(this.current.details, true);
  }

  private selectedGroup(): PhaseGroup | undefined {
    return this.groups()[this.phaseIndex];
  }

  private selectedAgent(): AgentRecord | undefined {
    return this.selectedGroup()?.agents[this.agentIndex];
  }

  private clampAgentIndex() {
    const agents = this.selectedGroup()?.agents ?? [];
    this.agentIndex = Math.min(this.agentIndex, Math.max(0, agents.length - 1));
  }

  private saveReport() {
    const entry = this.current;
    if (!entry) return;
    const target = path.join(runsDir(), entry.runId, "report.md");
    try {
      writeFileAtomic(target, buildWorkflowReport(entry.details));
      this.notice = `saved ${shortenHome(target)}`;
    } catch (error) {
      this.notice = `save failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.noticeAt = Date.now();
  }

  /** Request cancellation of a run by id, surfacing the outcome as a notice. */
  private abortRun(entry: RunEntry | undefined) {
    if (!entry) return;
    if (entry.details.status !== "running") {
      this.setNotice(`${entry.runId} is already ${entry.details.status}`);
      return;
    }
    const stopped = this.onAbort?.(entry.runId) ?? false;
    this.setNotice(
      stopped ? `stopping ${entry.runId}…` : `cannot stop ${entry.runId}`,
    );
  }

  private setNotice(text: string) {
    this.notice = text;
    this.noticeAt = Date.now();
  }

  handleInput(data: string) {
    const up = this.keybindings.matches(data, "tui.select.up") || data === "k";
    const down =
      this.keybindings.matches(data, "tui.select.down") || data === "j";
    const left =
      this.keybindings.matches(data, "tui.editor.cursorLeft") || data === "h";
    const right =
      this.keybindings.matches(data, "tui.editor.cursorRight") || data === "l";
    const confirm = this.keybindings.matches(data, "tui.select.confirm");
    const cancel = this.keybindings.matches(data, "tui.select.cancel");

    if (this.view === "list") {
      if (up) {
        this.listIndex = wrapSelection(this.listIndex, -1, this.entries.length);
      } else if (down) {
        this.listIndex = wrapSelection(this.listIndex, 1, this.entries.length);
      } else if (data === "g") {
        this.listIndex = 0;
      } else if (data === "G") {
        this.listIndex = Math.max(0, this.entries.length - 1);
      } else if (data === "x") {
        this.abortRun(this.entries[this.listIndex]);
      } else if (confirm || right) {
        const entry = this.entries[this.listIndex];
        if (entry) this.enterEntry(entry, false);
      } else if (cancel || left) {
        this.close();
        return;
      }
    } else if (this.view === "detail") {
      if (this.detailFocus === "phases") {
        if (up) {
          this.phaseIndex = wrapSelection(
            this.phaseIndex,
            -1,
            this.groups().length,
          );
          this.agentIndex = 0;
        } else if (down) {
          this.phaseIndex = wrapSelection(
            this.phaseIndex,
            1,
            this.groups().length,
          );
          this.agentIndex = 0;
        } else if (data === "g") {
          this.phaseIndex = 0;
          this.agentIndex = 0;
        } else if (data === "G") {
          this.phaseIndex = Math.max(0, this.groups().length - 1);
          this.agentIndex = 0;
        } else if (
          right ||
          (confirm && (this.selectedGroup()?.agents.length ?? 0) > 0)
        ) {
          if ((this.selectedGroup()?.agents.length ?? 0) > 0) {
            this.detailFocus = "agents";
            this.clampAgentIndex();
          }
        } else if (cancel || left) {
          if (this.openedDirectly) this.close();
          else {
            this.view = "list";
            this.refresh();
          }
        }
      } else {
        const agents = this.selectedGroup()?.agents ?? [];
        if (up) {
          this.agentIndex = wrapSelection(this.agentIndex, -1, agents.length);
        } else if (down) {
          this.agentIndex = wrapSelection(this.agentIndex, 1, agents.length);
        } else if (data === "g") {
          this.agentIndex = 0;
        } else if (data === "G") {
          this.agentIndex = Math.max(0, agents.length - 1);
        } else if (left || cancel) {
          this.detailFocus = "phases";
        } else if ((right || confirm) && this.selectedAgent()) {
          this.transcriptScroll = 0;
          this.view = "transcript";
        }
      }
      if (data === "s") this.saveReport();
      if (data === "x") this.abortRun(this.current);
    } else {
      const maxScroll = Math.max(
        0,
        this.transcriptRowCount - this.transcriptViewportSize,
      );
      const scrollStep =
        data === "j" || data === "k" ? TRANSCRIPT_SCROLL_STEP : 1;
      const pageStep = Math.max(1, this.transcriptViewportSize - 2);
      if (up) {
        this.transcriptScroll = Math.max(0, this.transcriptScroll - scrollStep);
      } else if (down) {
        this.transcriptScroll = Math.min(
          maxScroll,
          this.transcriptScroll + scrollStep,
        );
      } else if (matchesKey(data, Key.ctrl("u"))) {
        this.transcriptScroll = Math.max(0, this.transcriptScroll - pageStep);
      } else if (matchesKey(data, Key.ctrl("d"))) {
        this.transcriptScroll = Math.min(
          maxScroll,
          this.transcriptScroll + pageStep,
        );
      } else if (data === "g") {
        this.transcriptScroll = 0;
      } else if (data === "G") {
        this.transcriptScroll = maxScroll;
      } else if (cancel || left) {
        this.view = "detail";
        this.detailFocus = "agents";
      }
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(MIN_HEIGHT, this.tui.terminal.rows - 1);
    let lines: string[];
    if (this.view === "transcript" && this.current && this.selectedAgent()) {
      lines = this.renderTranscript(
        this.current.details,
        this.selectedAgent()!,
        width,
        height,
      );
    } else if (this.view === "detail" && this.current) {
      lines = this.renderDetail(this.current.details, width, height);
    } else {
      lines = this.renderList(width, height);
    }
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  /** Compose `left ... right` within `width`, truncating left when needed. */
  private split(left: string, right: string, width: number): string {
    const rightWidth = visibleWidth(right);
    let text = left;
    if (visibleWidth(text) + rightWidth + 1 > width) {
      text = truncateToWidth(text, Math.max(0, width - rightWidth - 2), "…");
    }
    const pad = Math.max(1, width - visibleWidth(text) - rightWidth);
    return text + " ".repeat(pad) + right;
  }

  /** Bordered panel with a title in the top border, padded to exact height. */
  private panel(
    title: string,
    rows: string[],
    width: number,
    height: number,
  ): string[] {
    return panelFrame(this.theme, { label: title, rows, width, height });
  }

  /** Scroll window keeping `selected` visible. */
  private windowed<T>(
    items: T[],
    selected: number,
    size: number,
  ): { items: T[]; offset: number } {
    if (items.length <= size) return { items, offset: 0 };
    const offset = Math.max(
      0,
      Math.min(selected - Math.floor(size / 2), items.length - size),
    );
    return { items: items.slice(offset, offset + size), offset };
  }

  private keys(binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
    return this.keybindings.getKeys(binding).join("/") || "unbound";
  }

  private hintLine(hints: readonly ScreenHint[], width: number): string {
    return sharedHintLine(this.theme, hints, width, this.notice);
  }

  private renderList(width: number, height: number): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    lines.push(
      screenTitleLine(
        theme,
        "Workflows",
        `${this.entries.length} run${this.entries.length === 1 ? "" : "s"}`,
        width,
      ),
    );

    const panelHeight = height - 2;
    const bodyHeight = Math.max(0, panelHeight - 2);

    if (this.entries.length === 0) {
      lines.push(
        ...this.panel(
          "Runs",
          [theme.fg("dim", " no workflow runs for this request")],
          width,
          panelHeight,
        ),
      );
      lines.push(
        this.hintLine([[this.keys("tui.select.cancel"), "close"]], width),
      );
      return lines;
    }

    const { items, offset } = this.windowed(
      this.entries,
      this.listIndex,
      bodyHeight,
    );
    const rows = items.map((entry, i) => {
      const index = offset + i;
      const selected = index === this.listIndex;
      const d = entry.details;
      const marker = selected ? theme.fg("accent", "❯") : " ";
      const name = d.name ?? d.runId;
      const label = selected
        ? theme.fg("accent", name)
        : theme.fg("text", name);
      const { done, failed } = countStates(d);
      const settled = done + failed;
      const right =
        theme.fg(
          "dim",
          `${settled}/${d.agents.length} agents · ${formatElapsed(d.startedAt, d.finishedAt)} · `,
        ) +
        theme.fg(statusColor(d.status), statusWord(d.status)) +
        " ";
      const left = ` ${marker} ${statusGlyph(d.status, theme, Date.now())} ${label} ${theme.fg("dim", d.runId)}`;
      return this.split(left, right, width - 2);
    });
    lines.push(...this.panel("Runs", rows, width, panelHeight));
    lines.push(
      this.hintLine(
        [
          [
            `${this.keys("tui.select.up")}/${this.keys("tui.select.down")}`,
            "select",
          ],
          [this.keys("tui.select.confirm"), "open"],
          ["x", "stop"],
          [this.keys("tui.select.cancel"), "close"],
        ],
        width,
      ),
    );
    return lines;
  }

  private renderDetail(
    d: WorkflowDetails,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const lines: string[] = [];

    const { done, failed } = countStates(d);
    const settled = done + failed;
    // Same language as the transcript card: the glyph carries the state, the
    // status word only shows for terminal states.
    const right =
      theme.fg(
        "dim",
        `${settled}/${d.agents.length} agents · ${formatElapsed(d.startedAt, d.finishedAt)}`,
      ) +
      (d.status === "running"
        ? " "
        : theme.fg("dim", " · ") +
          theme.fg(statusColor(d.status), statusWord(d.status)) +
          " ");
    lines.push(
      this.split(
        ` ${statusGlyph(d.status, theme, Date.now())} ${theme.bold(theme.fg("accent", d.name ?? d.runId))}`,
        right,
        width,
      ),
    );
    const totals = formatUsage(aggregateUsage(d.agents));
    // A graph with no edges is a flat swarm — "N nodes · 0 edges" is noise.
    const graphSummary =
      d.graph && d.graph.edges.length > 0
        ? workflowGraphSummary(d.graph)
        : undefined;
    const subRight = [graphSummary, totals].filter(Boolean).join(" · ");
    const subLeft = " " + theme.fg("muted", d.description ?? d.runId);
    lines.push(
      this.split(
        subLeft,
        subRight ? theme.fg("dim", `${subRight} `) : " ",
        width,
      ),
    );

    const groups = this.groups();
    this.phaseIndex = Math.min(this.phaseIndex, Math.max(0, groups.length - 1));
    const selectedGroup = groups[this.phaseIndex];
    this.clampAgentIndex();

    // A narrator strip under the panels, since log() is run-wide and belongs to
    // no single phase. It yields rows to the panels first: on a short terminal
    // the agent list is what the view exists for.
    const logBudget = Math.max(0, Math.min(3, height - 12));
    const recentLogs = (d.logs ?? []).slice(-logBudget);
    const panelHeight = height - 3 - recentLogs.length;
    const bodyHeight = Math.max(0, panelHeight - 2);

    // Left: phases sidebar.
    const maxTitle = Math.max(8, ...groups.map((g) => g.title.length));
    const sidebarWidth = Math.min(
      Math.max(maxTitle + 12, 20),
      Math.floor(width / 3),
    );
    const sidebarInner = sidebarWidth - 2;
    const phaseWindow = this.windowed(groups, this.phaseIndex, bodyHeight);
    const phaseRows = phaseWindow.items.map((group, i) => {
      const index = phaseWindow.offset + i;
      const selected = index === this.phaseIndex;
      const marker = selected
        ? theme.fg(this.detailFocus === "phases" ? "accent" : "muted", "❯")
        : " ";
      const groupDone = group.agents.filter(
        (a) => a.state !== "running",
      ).length;
      const square = groupGlyph(group, theme);
      const title =
        selected && this.detailFocus === "phases"
          ? theme.fg("accent", group.title)
          : theme.fg("text", group.title);
      const counts =
        group.agents.length > 0
          ? theme.fg("dim", `${groupDone}/${group.agents.length} `)
          : theme.fg("dim", "- ");
      return this.split(` ${marker} ${square} ${title}`, counts, sidebarInner);
    });

    // Right: agents in the selected phase.
    const agentsWidth = width - sidebarWidth - 1;
    const agentsInner = agentsWidth - 2;
    const agentRows: string[] = [];
    if (selectedGroup) {
      const maxLabel = Math.max(
        0,
        ...selectedGroup.agents.map((a) => a.label.length),
      );
      const models = new Set(
        selectedGroup.agents.map((a) => a.model).filter(Boolean),
      );
      const mixedModels = models.size > 1;
      const agentWindow = this.windowed(
        selectedGroup.agents,
        this.agentIndex,
        bodyHeight,
      );
      for (const [visibleIndex, agent] of agentWindow.items.entries()) {
        const index = agentWindow.offset + visibleIndex;
        const selected = index === this.agentIndex;
        const marker =
          selected && this.detailFocus === "agents"
            ? theme.fg("accent", "❯")
            : " ";
        // The model repeats on every row when the run is homogeneous; only
        // mixed fleets earn a per-row model. Context occupancy matters while
        // an agent runs; once settled, its cost is the elapsed on the right.
        const percent = contextPercent({
          tokens: agent.usage.contextTokens,
          contextWindow: agent.contextWindow,
        });
        const stats = [
          mixedModels ? agent.model : undefined,
          agent.state === "running" && percent !== undefined
            ? `${percent}%`
            : undefined,
          agent.acceptance
            ? `acceptance:${agent.acceptance.status}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        const label =
          selected && this.detailFocus === "agents"
            ? theme.fg("accent", agent.label.padEnd(Math.min(maxLabel, 40)))
            : theme.fg("text", agent.label.padEnd(Math.min(maxLabel, 40)));
        const left = ` ${marker} ${stateGlyph(agent.state, theme, Date.now())} ${label}${stats ? `  ${theme.fg("dim", stats)}` : ""}`;
        const right = theme.fg(
          "dim",
          `${formatElapsed(agent.startedAt, agent.finishedAt)} `,
        );
        agentRows.push(this.split(left, right, agentsInner));
        if (agent.error) {
          agentRows.push(
            truncateToWidth(
              `       ${theme.fg("error", displayError(agent.error))}`,
              agentsInner,
              "…",
            ),
          );
        }
      }
      if (selectedGroup.agents.length === 0) {
        agentRows.push(theme.fg("dim", " no agents in this phase yet"));
      }
    }
    if (d.error) {
      agentRows.push("");
      agentRows.push(
        truncateToWidth(
          ` ${theme.fg("error", `workflow error: ${d.error}`)}`,
          agentsInner,
          "…",
        ),
      );
    }

    const agentCount = selectedGroup?.agents.length ?? 0;
    const agentsTitle = selectedGroup
      ? `${selectedGroup.title} · ${agentCount} agent${agentCount === 1 ? "" : "s"}`
      : "Agents";
    const leftPanel = this.panel(
      "Phases",
      phaseRows,
      sidebarWidth,
      panelHeight,
    );
    const rightPanel = this.panel(
      agentsTitle,
      agentRows,
      agentsWidth,
      panelHeight,
    );
    for (let i = 0; i < panelHeight; i++) {
      lines.push(`${leftPanel[i] ?? ""} ${rightPanel[i] ?? ""}`);
    }
    for (const entry of recentLogs) {
      lines.push(
        truncateToWidth(
          ` ${theme.fg("muted", "›")} ${theme.fg("dim", entry.text)}`,
          width,
          "…",
        ),
      );
    }

    const hints: ScreenHint[] =
      this.detailFocus === "phases"
        ? [
            ["j/k", "select phase"],
            [
              `l/${this.keys("tui.editor.cursorRight")}/${this.keys("tui.select.confirm")}`,
              "agents",
            ],
            [this.keys("tui.select.cancel"), "back"],
            ["x", "stop"],
            ["s", "save report"],
          ]
        : [
            ["j/k", "select agent"],
            [
              `h/${this.keys("tui.editor.cursorLeft")}/${this.keys("tui.select.cancel")}`,
              "phases",
            ],
            [
              `l/${this.keys("tui.editor.cursorRight")}/${this.keys("tui.select.confirm")}`,
              "details",
            ],
            ["x", "stop"],
            ["s", "save report"],
          ];
    lines.push(this.hintLine(hints, width));
    return lines;
  }

  private transcriptRows(agent: AgentRecord, width: number): string[] {
    const theme = this.theme;
    const rows: string[] = [];
    if (agent.transcript.length === 0) {
      return [
        theme.fg(
          "dim",
          " transcript unavailable (this run predates transcript capture)",
        ),
      ];
    }

    for (const entry of agent.transcript) {
      // Tool calls are one-liners: the arrow shows direction, the accent name
      // says what ran, and the arguments collapse to a single compact line
      // instead of a vertical JSON block.
      if (entry.role === "tool") {
        const name = entry.name ? sanitizeLine(entry.name, 160) : "unknown";
        const args = compactInlineJson(entry.text);
        rows.push(
          ` ${theme.fg("muted", "→")} ${theme.fg("accent", name)}${args ? theme.fg("dim", ` ${args}`) : ""}`,
        );
        continue;
      }
      const label = transcriptLabel(entry);
      const color = transcriptColor(entry);
      const marker = entry.role === "toolResult" ? "←" : "●";
      rows.push(
        ` ${theme.fg(color, marker)} ${theme.bold(theme.fg(color, label))}`,
      );
      const contentWidth = Math.max(8, width - 4);
      const styled = theme.fg(
        entry.role === "thinking" || entry.role === "toolResult"
          ? "dim"
          : entry.isError
            ? "error"
            : "text",
        sanitizeTerminalText(entry.text),
      );
      for (const line of wrapTextWithAnsi(styled, contentWidth)) {
        rows.push(`   ${line}`);
      }
      rows.push("");
    }
    return rows;
  }

  private renderTranscript(
    details: WorkflowDetails,
    agent: AgentRecord,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    const right = theme.fg(
      "dim",
      [
        agent.model,
        agentContext(agent),
        agent.acceptance ? `acceptance:${agent.acceptance.status}` : undefined,
        formatElapsed(agent.startedAt, agent.finishedAt),
      ]
        .filter(Boolean)
        .join(" · ") + " ",
    );
    lines.push(
      this.split(
        ` ${stateGlyph(agent.state, theme, Date.now())} ${theme.bold(theme.fg("accent", agent.label))}`,
        right,
        width,
      ),
    );
    lines.push(
      this.split(
        ` ${theme.fg("muted", `${details.name ?? details.runId} · ${agent.phase ?? "unphased"}`)}`,
        theme.fg("dim", `${agent.transcript.length} entries `),
        width,
      ),
    );

    const panelHeight = height - 3;
    const bodyHeight = Math.max(1, panelHeight - 2);
    const rows = this.transcriptRows(agent, width - 2);
    this.transcriptRowCount = rows.length;
    this.transcriptViewportSize = bodyHeight;
    const maxScroll = Math.max(0, rows.length - bodyHeight);
    this.transcriptScroll = Math.min(this.transcriptScroll, maxScroll);
    const visible = rows.slice(
      this.transcriptScroll,
      this.transcriptScroll + bodyHeight,
    );
    const position =
      rows.length > bodyHeight
        ? `Transcript · ${this.transcriptScroll + 1}-${Math.min(rows.length, this.transcriptScroll + bodyHeight)}/${rows.length}`
        : "Transcript";
    lines.push(...this.panel(position, visible, width, panelHeight));
    lines.push(
      this.hintLine(
        [
          ["j/k", "scroll"],
          ["ctrl-u/d", "page"],
          ["g/G", "top/bottom"],
          ["h/left/esc", "back"],
        ],
        width,
      ),
    );
    return lines;
  }
}

/**
 * Agent errors often arrive as an HTTP status plus a JSON body
 * (`429: {"message":"user rate limit exceeded …"}`); the panel row keeps the
 * status code and the message, dropping the braces and quotes.
 */
function displayError(error: string): string {
  const clean = sanitizeLine(error, 2_000);
  const match = clean.match(/^(\d{3})[:\s]*\{\s*"message"\s*:\s*"([^"]+)"/);
  if (match) return `${match[1]}: ${match[2]}`;
  return clean;
}

function transcriptLabel(entry: TranscriptEntry): string {
  if (entry.role === "user") return "user";
  if (entry.role === "assistant") return "assistant";
  if (entry.role === "thinking") return "thinking";
  const name = entry.name ? sanitizeLine(entry.name, 160) : "unknown";
  return name;
}

/**
 * Tool arguments arrive pretty-printed over many lines; the transcript shows
 * them inline. Non-JSON text passes through flattened.
 */
function compactInlineJson(text: string): string {
  const flat = text.trim();
  if (!flat) return "";
  try {
    return JSON.stringify(JSON.parse(flat));
  } catch {
    return flat.replace(/\s+/g, " ");
  }
}

function transcriptColor(
  entry: TranscriptEntry,
): "accent" | "success" | "dim" | "warning" | "error" | "muted" {
  if (entry.isError) return "error";
  if (entry.role === "user") return "accent";
  if (entry.role === "assistant") return "success";
  if (entry.role === "thinking") return "dim";
  if (entry.role === "tool") return "warning";
  return "muted";
}

function groupGlyph(group: PhaseGroup, theme: Theme): string {
  if (group.agents.length === 0) return theme.fg("dim", "○");
  if (group.agents.some((a) => a.state === "running"))
    return theme.fg("warning", spinnerFrame(Date.now()));
  if (group.agents.some((a) => a.state === "error"))
    return theme.fg("error", "✗");
  return theme.fg("success", "✓");
}

/** Open the dashboard as a full-screen overlay. */
export async function showWorkflowDashboard(
  ctx: ExtensionContext,
  getActive: () => Map<string, WorkflowDetails>,
  initialRunId?: string,
  startedSince = 0,
  onAbort?: (runId: string) => boolean,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const dashboard: WorkflowDashboard = new WorkflowDashboard(
        tui,
        theme,
        keybindings,
        getActive,
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
        startedSince,
        () => {
          dashboard.dispose();
          done(undefined);
        },
        initialRunId,
        onAbort,
      );
      return dashboard;
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
