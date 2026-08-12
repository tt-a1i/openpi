/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   log(message)                                  // narrate progress to the user and the report
 *   usage()                                       // cumulative token spend so far (read-only)
 *   await agent(prompt, { agent_type?, label?, phase?, schema?, model?, provider?, effort? })
 *   await pipeline(items, stage1, stage2, ...)    // per-item, no barrier between stages
 *   await parallel([() => agent(...), ...], { concurrency? })  // barrier
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts.
 *
 * `resume_from_run_id` replays a prior run's cached agent results. Matching is
 * by call CONTENT, not by ordinal: `pipeline()` issues calls in an order that
 * depends on real agent latency, so an ordinal would drift between runs and
 * hand one item's result to another. See `journal.ts`.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CustomEditor,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { waitBounded } from "../shared/child-session.ts";
import { loadSetupConfig } from "../shared/setup-config.ts";
import {
  loadAgentTypes,
  resolveAgentModel,
  roleModelForAgentType,
  selectSubagentModel,
} from "../subagents/src/agent-types.ts";
import {
  createWorktree,
  reclaimWorktree,
  type Worktree,
  type WorktreeCleanup,
} from "../shared/worktree.ts";
import {
  createWorkflowPersistence,
  loadJournal,
  persistWorkflowJson,
} from "./artifacts.ts";
import { createWorkflowHandoffRegistry } from "./handoff.ts";
import {
  classifyInterruptedInvocation,
  createInvocationIdentity,
  requestInvocation,
  transitionInvocation,
} from "./invocation-ledger.ts";
import {
  normalizeWorkflowOperatorKey,
  WorkflowOperatorRegistry,
} from "./operator.ts";
import {
  agentCallKey,
  createReplayCache,
  type JournalEntry,
  type ReplayCache,
} from "./journal.ts";
import { RunController } from "./controller.ts";
import {
  normalizePersistedWorkflowDetails,
  recoverStaleWorkflowDetails,
  sessionWorkflowRunIds,
  showWorkflowDashboard,
} from "./dashboard.ts";
import {
  extractMeta,
  prepareWorkflowScript,
  type WorkflowMeta,
} from "./meta.ts";
import {
  agentContext,
  aggregateUsage,
  appendLog,
  countStates,
  emptyUsage,
  formatElapsed,
  formatUsage,
  isWorkflowRunId,
  phaseGroups,
  resolveWorkflowRunTarget,
  resultJson,
  sanitizeLine,
  sanitizeWorkflowDisplayLine,
  sanitizeWorkflowDisplayText,
  stateSquare,
  statusColor,
  statusWord,
  createUsageReader,
  refreshWorkflowGraph,
  SQUARE,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowAgentPrompt,
  buildWorkflowResultMessage,
  WORKFLOW_LIFECYCLE_PROMPT_SNIPPET,
  WORKFLOW_PARAMETER_DESCRIPTIONS,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_STATUS_PARAMETER_DESCRIPTIONS,
  WORKFLOW_STATUS_TOOL_DESCRIPTION,
  WORKFLOW_STOP_PARAMETER_DESCRIPTIONS,
  WORKFLOW_STOP_TOOL_DESCRIPTION,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  WorkflowNavigationEditor,
  WorkflowStripState,
  WorkflowStripWidget,
  type WorkflowStripEntry,
} from "./navigation.ts";
import {
  createWorkflowResources,
  runAgent,
  type ThinkingLevel,
  type WorkflowModel,
} from "./runner.ts";
import {
  beginProcessReplayWorkspaceLease,
  createReplayIdentity,
  isReplaySafeAgentCall,
} from "./replay-safety.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import {
  acceptanceInstruction,
  acceptanceSchema,
  applyAcceptance,
  evaluateAcceptance,
  parseAcceptanceContract,
} from "./acceptance.ts";
import {
  finalizeWorktreeHandoff,
  prepareWorktreeHandoff,
} from "./worktree-handoff.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  /** Opaque same-run handle for bounded downstream handoff. */
  ref?: string;
  acceptance?: AgentRecord["acceptance"];
  error?: string;
}

interface AgentCallOptions {
  agent_type?: unknown;
  label?: unknown;
  phase?: unknown;
  schema?: unknown;
  acceptance?: unknown;
  model?: unknown;
  provider?: unknown;
  effort?: unknown;
  isolation?: unknown;
  /** Reuse one in-memory child Session within this workflow run. */
  operator?: unknown;
  /** Same-run result refs to hydrate as bounded untrusted input data. */
  inputs?: unknown;
}

const WorkflowParams = Type.Object({
  script: Type.String({
    description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
  }),
  args: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
    }),
  ),
  resume_from_run_id: Type.Optional(
    Type.String({
      description: WORKFLOW_PARAMETER_DESCRIPTIONS.resumeFromRunId,
    }),
  ),
});

type WorkflowInput = Static<typeof WorkflowParams>;

/** Resolve a persisted run without letting a suffix collision choose one. */
export function resolveRunDir(target: string) {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(isWorkflowRunId);
  } catch {
    // The shared resolver reports the empty candidate set usefully.
  }

  // Shape validation happens before any target-derived path is built. This
  // value is model-supplied, so traversal must never reach a planted journal.
  const resolution = resolveWorkflowRunTarget(target, names);
  return resolution.ok
    ? { ...resolution, runDir: path.join(base, resolution.runId) }
    : resolution;
}

/** Backward-compatible directory lookup for callers that only need a hit. */
export function findRunDir(target: string) {
  const resolution = resolveRunDir(target);
  return resolution.ok ? resolution.runDir : undefined;
}

function errorText(error: unknown): string {
  return sanitizeWorkflowDisplayLine(
    error instanceof Error ? error.message : String(error),
  );
}

function summaryLine(details: WorkflowDetails): string {
  const { done, failed } = countStates(details);
  const settled = done + failed;
  // The newest narrator line beats the phase title when there is one: the
  // script wrote it precisely because it says more than the phase does.
  const latest = details.logs?.[details.logs.length - 1]?.text;
  return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
    latest
      ? ` · ${latest}`
      : details.currentPhase
        ? ` · ${details.currentPhase}`
        : ""
  }`;
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

export interface ActiveWorkflowRunLifecycle {
  details: WorkflowDetails;
  controller: Pick<RunController, "abort" | "settle">;
  completion?: Promise<void>;
  forceSettle(error: string): void;
}

/** Abort every live child and bound the whole session-shutdown barrier once. */
export async function shutdownActiveWorkflowRuns(
  runs: readonly ActiveWorkflowRunLifecycle[],
  timeoutMs = 8_000,
) {
  for (const run of runs) run.controller.abort("Session is shutting down");
  const completions = runs
    .map((run) => run.completion)
    .filter(
      (completion): completion is Promise<void> => completion !== undefined,
    );
  const completed = await waitBounded(
    Promise.allSettled([
      ...runs.map((run) => run.controller.settle({ abort: true })),
      ...completions,
    ]),
    timeoutMs,
  );
  if (!completed) {
    for (const run of runs) {
      run.forceSettle("Session shutdown deadline exceeded");
    }
  }
  return completed;
}

interface RunSummary {
  runId: string;
  name?: string;
  status: string;
  done: number;
  total: number;
  startedAt: number;
  active: boolean;
}

function listRuns(
  activeRuns: Map<string, WorkflowDetails>,
  sessionId: string,
  referencedRunIds: ReadonlySet<string>,
  startedSince = 0,
): RunSummary[] {
  const base = path.join(getAgentDir(), "workflows");
  let names: string[] = [];
  try {
    names = fs.readdirSync(base).filter(isWorkflowRunId);
  } catch {
    // No runs yet.
  }
  const summaries: RunSummary[] = [];
  for (const runId of names) {
    const live = activeRuns.get(runId);
    if (live) {
      const { done, failed } = countStates(live);
      summaries.push({
        runId,
        name: live.name,
        status: live.status,
        done: done + failed,
        total: live.agents.length,
        startedAt: live.startedAt,
        active: true,
      });
      continue;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(base, runId, "workflow.json"), "utf8"),
      ) as Partial<WorkflowDetails>;
      const startedAt = parsed.startedAt ?? 0;
      const touchedAt = Math.max(startedAt, parsed.finishedAt ?? 0);
      if (
        touchedAt < startedSince ||
        (parsed.sessionId !== sessionId && !referencedRunIds.has(runId))
      ) {
        continue;
      }
      const agents = parsed.agents ?? [];
      summaries.push({
        runId,
        name: parsed.name,
        status:
          parsed.status === "running"
            ? "aborted"
            : (parsed.status ?? "unknown"),
        done: agents.filter((agent) => agent.state !== "running").length,
        total: agents.length,
        startedAt: parsed.startedAt ?? 0,
        active: false,
      });
    } catch {
      // Ignore unreadable artifacts because their session cannot be verified.
    }
  }
  return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

function runDetailText(
  run: RunSummary,
  activeRuns: Map<string, WorkflowDetails>,
): string {
  const runDir = path.join(getAgentDir(), "workflows", run.runId);
  const live = activeRuns.get(run.runId);
  if (live) return buildWorkflowResultMessage(live, runDir);
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    return buildWorkflowResultMessage(parsed, runDir);
  } catch {
    return `Run ${run.runId} — ${run.status}`;
  }
}

export default function workflows(pi: ExtensionAPI) {
  /** Live background runs, for /workflows and shutdown cleanup. */
  const activeRuns = new Map<string, ActiveWorkflowRunLifecycle>();
  const activeDetails = () =>
    new Map(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );
  const settledRuns = new Map<string, WorkflowDetails>();
  const stripState = new WorkflowStripState();
  const widgetKey = "workflow-navigation";

  /**
   * Finished counts are an unread notice: opening the dashboard or sending the
   * next explicit request acknowledges them.
   */
  let lastContext: ExtensionContext | undefined;
  let widgetVisible = false;
  let requestWidgetRender: (() => void) | undefined;
  let dashboardOpen = false;
  /**
   * Start of the current request. The dashboard reports the work belonging to
   * it, not the whole session's run history.
   */
  let turnStartedAt = 0;
  let agentTypes = loadAgentTypes({
    agentDir: getAgentDir(),
    cwd: process.cwd(),
    projectTrusted: false,
  }).agentTypes;

  const newestEntry = (
    entries: Iterable<readonly [string, WorkflowDetails]>,
  ): WorkflowStripEntry | undefined => {
    let newest: WorkflowStripEntry | undefined;
    for (const [runId, details] of entries) {
      if (!newest || details.startedAt > newest.details.startedAt) {
        newest = { runId, details };
      }
    }
    return newest;
  };

  const stripEntry = () => {
    const running = newestEntry(
      [...activeRuns].map(([runId, run]) => [runId, run.details] as const),
    );
    return running ?? newestEntry(settledRuns);
  };

  const updateWorkflowWidget = () => {
    const ctx = lastContext;
    if (!ctx || ctx.mode !== "tui") return;
    const visible = Boolean(stripEntry());
    if (visible === widgetVisible) return;
    if (!visible) {
      stripState.focused = false;
      requestWidgetRender = undefined;
      ctx.ui.setWidget(widgetKey, undefined);
      widgetVisible = false;
      return;
    }
    ctx.ui.setWidget(
      widgetKey,
      (tui, theme) => {
        requestWidgetRender = () => tui.requestRender();
        return new WorkflowStripWidget(tui, theme, stripState, stripEntry);
      },
      // Above the editor, like the Subagents HUD: one contiguous block between
      // the transcript and the prompt, never torn apart by tool rows.
      { placement: "aboveEditor" },
    );
    widgetVisible = true;
  };

  const updateIndicator = () => {
    const ctx = lastContext;
    if (!ctx) return;
    try {
      // Activity is reported by the HUD above the editor (header metrics,
      // per-agent rows) — deliberately NOT also pinned to the footer status
      // bar, so workflow state lives in exactly one place.
      updateWorkflowWidget();
    } catch {
      // UI may be unavailable.
    }
  };

  const acknowledgeSettledRuns = () => {
    settledRuns.clear();
  };

  const recordSettledRun = (details: WorkflowDetails) => {
    settledRuns.set(details.runId, details);
  };

  const stopRun = (runId: string) => {
    const run = activeRuns.get(runId);
    if (!run || run.details.status !== "running") return false;
    run.controller.abort("Stopped by user");
    return true;
  };

  const openDashboard = async (
    ctx: ExtensionContext,
    initialRunId?: string,
    startedSince = turnStartedAt,
  ) => {
    if (dashboardOpen || ctx.mode !== "tui") return;
    dashboardOpen = true;
    stripState.focused = false;
    try {
      await showWorkflowDashboard(
        ctx,
        activeDetails,
        initialRunId,
        startedSince,
        stopRun,
      );
      acknowledgeSettledRuns();
    } finally {
      dashboardOpen = false;
      updateIndicator();
    }
  };

  const installWorkflowNavigation = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const base =
        previous?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings);
      return new WorkflowNavigationEditor(
        base,
        keybindings,
        stripState,
        () => Boolean(stripEntry()),
        () => {
          const entry = stripEntry();
          if (entry) void openDashboard(ctx, entry.runId);
        },
        () => {
          requestWidgetRender?.();
          tui.requestRender();
        },
      );
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) lastContext = ctx;
    agentTypes = loadAgentTypes({
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    }).agentTypes;
    turnStartedAt = 0;
    settledRuns.clear();
    installWorkflowNavigation(ctx);
    updateIndicator();
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    turnStartedAt = Date.now();
    acknowledgeSettledRuns();
    updateIndicator();
  });

  pi.on("session_shutdown", async () => {
    await shutdownActiveWorkflowRuns([...activeRuns.values()]);
    try {
      lastContext?.ui.setStatus("workflows", undefined);
      lastContext?.ui.setWidget(widgetKey, undefined);
    } catch {
      // UI may already be disposed.
    }
    lastContext = undefined;
    widgetVisible = false;
    requestWidgetRender = undefined;
    stripState.focused = false;
  });

  pi.registerCommand("workflows", {
    description:
      "List workflow runs (`/workflows <runId>` for detail, `/workflows <runId> stop` to cancel)",
    handler: async (rawArgs, ctx) => {
      const arg = rawArgs.trim();

      // `/workflows <runId> stop` (or `stop <runId>`) cancels a running
      // workflow. Background runs otherwise only stop at session shutdown.
      const stopMatch = arg.match(/^(?:stop\s+(\S+)|(\S+)\s+stop)$/i);
      if (stopMatch) {
        const target = stopMatch[1] ?? stopMatch[2];
        const running = [...activeRuns].filter(
          ([, run]) => run.details.status === "running",
        );
        const resolution = resolveWorkflowRunTarget(
          target,
          running.map(([runId]) => runId),
        );
        if (!resolution.ok) {
          ctx.ui.notify(resolution.error, "warning");
          return;
        }
        activeRuns.get(resolution.runId)?.controller.abort("Stopped by user");
        ctx.ui.notify(`Stopping workflow ${resolution.runId}…`, "info");
        return;
      }

      // An explicit run id is a deliberate lookup, so it reaches session history.
      const startedSince = arg ? 0 : turnStartedAt;
      if (ctx.mode === "tui") {
        lastContext = ctx;
        await openDashboard(ctx, arg || undefined, startedSince);
        return;
      }
      // Non-TUI fallback: plain text listing.
      const runs = listRuns(
        activeDetails(),
        ctx.sessionManager.getSessionId(),
        sessionWorkflowRunIds(ctx),
        startedSince,
      );
      if (arg) {
        const resolution = resolveWorkflowRunTarget(
          arg,
          runs.map((run) => run.runId),
        );
        if (!resolution.ok) {
          ctx.ui.notify(resolution.error, "warning");
          return;
        }
        const run = runs.find(
          (candidate) => candidate.runId === resolution.runId,
        );
        if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
        return;
      }
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs for this request.", "info");
        return;
      }
      const labels = runs.map(
        (r) =>
          `${r.active ? "* " : "  "}${r.runId}  ${r.status}  ${r.name ?? ""}  ${r.done}/${r.total}`,
      );
      if (!ctx.hasUI) {
        ctx.ui.notify(labels.join("\n"), "info");
        return;
      }
      const choice = await ctx.ui.select("Workflow runs", labels);
      if (!choice) return;
      const run = runs[labels.indexOf(choice)];
      if (run) ctx.ui.notify(runDetailText(run, activeDetails()), "info");
    },
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: WorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let prepared: ReturnType<typeof prepareWorkflowScript>;
      try {
        prepared = prepareWorkflowScript(params.script);
      } catch (error) {
        throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
      }

      let args: unknown;
      if (params.args !== undefined) {
        try {
          args = JSON.parse(params.args);
        } catch {
          args = params.args;
        }
      }

      const meta = prepared.meta;
      const runId = `wf_${randomBytes(6).toString("hex")}`;
      const runDir = path.join(getAgentDir(), "workflows", runId);
      const background = (params.background ?? false) && ctx.hasUI;

      const details: WorkflowDetails = {
        runId,
        sessionId: ctx.sessionManager.getSessionId(),
        name: meta.name,
        description: meta.description,
        background,
        status: "running",
        startedAt: Date.now(),
        phases: [...meta.phases],
        agents: [],
      };

      // Resume: replay cached results for calls whose content is unchanged.
      // A missing or unreadable source degrades to a normal full run — resume
      // is an optimization and must not become a new way to fail.
      const journalEntries: JournalEntry[] = [];
      let replay: ReplayCache | undefined;
      if (params.resume_from_run_id) {
        const source = resolveRunDir(params.resume_from_run_id);
        const journal = source.ok ? loadJournal(source.runDir) : undefined;
        if (source.ok && journal && journal.entries.length > 0) {
          replay = createReplayCache(journal);
          details.resumedFrom = source.runId;
        } else {
          details.resumeNote = source.ok
            ? `No replayable results found in ${source.runId}; ran everything fresh.`
            : `${source.error}; ran everything fresh.`;
        }
      }

      writeRunFile(runDir, "script.js", params.script);
      if (params.args !== undefined)
        writeRunFile(runDir, "args.json", params.args);
      persistWorkflowJson(runDir, details);
      const persistence = createWorkflowPersistence(runDir, details, {
        journal: () => journalEntries,
      });

      // Background runs survive Esc on the parent turn, but all runs are
      // aborted and settled during session shutdown.
      const workflowConfig = loadSetupConfig().workflows;
      const projectTrusted = ctx.isProjectTrusted();
      const runAgentTypes = agentTypes;
      const controller = new RunController(
        background ? undefined : signal,
        workflowConfig.concurrency,
        workflowConfig.maxAgentCalls,
      );
      const handoffs = createWorkflowHandoffRegistry();
      const operators = new WorkflowOperatorRegistry();

      // Each concurrent child gets its own extension runtime. Children use the
      // parent's live trust decision; an isolated child gets its own cwd (its
      // worktree) but keeps that decision, since it is the same project at the
      // same commit.
      const getResources = (
        structured: boolean,
        cwd: string,
        agentTypePrompt?: string,
      ) =>
        createWorkflowResources(
          cwd,
          structured ? "structured" : "plain",
          projectTrusted,
          agentTypePrompt,
        );

      // Throttled progress: tool-block updates when blocking. Background
      // runs are covered by the below-editor indicator and /workflows.
      let emitTimer: ReturnType<typeof setTimeout> | undefined;
      let lastEmit = 0;
      let runSettled = false;
      const flush = (terminal = false) => {
        emitTimer = undefined;
        if (runSettled && !terminal) return;
        lastEmit = Date.now();
        if (background) return;
        onUpdate?.({
          content: [{ type: "text", text: summaryLine(details) }],
          details: compactToolDetails(details),
        });
      };
      const emit = (checkpoint = true) => {
        if (runSettled) return;
        refreshWorkflowGraph(details);
        if (checkpoint) persistence.checkpoint();
        if (emitTimer) return;
        emitTimer = setTimeout(
          flush,
          Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)),
        );
      };
      const flushNow = (terminal = false) => {
        if (emitTimer) clearTimeout(emitTimer);
        flush(terminal);
      };

      const terminalize = (
        status: WorkflowDetails["status"],
        error?: string,
      ) => {
        if (runSettled) return false;
        runSettled = true;
        if (emitTimer) {
          clearTimeout(emitTimer);
          emitTimer = undefined;
        }
        controller.abort(
          error ??
            (status === "completed"
              ? "Workflow completed"
              : "Workflow was settled"),
        );
        for (const record of details.agents) {
          if (record.state !== "running") continue;
          if (
            record.invocation &&
            record.invocation.executionState !== "settled" &&
            record.invocation.executionState !== "uncertain"
          ) {
            record.invocation = classifyInterruptedInvocation(
              record.invocation,
              Date.now(),
            );
          }
          record.state = "error";
          record.error =
            record.error ?? "Agent did not settle before run cleanup";
          record.finishedAt = Date.now();
        }
        details.status = status;
        details.finishedAt = Date.now();
        refreshWorkflowGraph(details);
        if (error) details.error = sanitizeWorkflowDisplayLine(error);
        return true;
      };

      const forceSettle = (error: string) => {
        if (!terminalize("failed", error)) return;
        try {
          persistence.flush();
        } catch (persistenceError) {
          details.error = `${error}; artifact persistence failed: ${errorText(persistenceError)}`;
        }
        flushNow(true);
      };

      const phaseFn = (title: unknown) => {
        if (runSettled) return;
        const text = sanitizeLine(String(title), 160);
        if (!text) return;
        details.currentPhase = text;
        if (!details.phases.some((p) => p.title === text))
          details.phases.push({ title: text });
        emit();
      };

      // The script's narrator. Unlike phase(), this is append-only progress
      // text, so it never mutates the phase list a run is judged against.
      const logFn = (text: string) => {
        if (runSettled) return;
        appendLog(details, text, Date.now());
        emit();
      };

      // One reader per run: it carries a high-water mark, because per-agent
      // usage is recomputed from a message list that compaction shrinks.
      const readUsage = createUsageReader(details.agents);

      let agentCounter = 0;
      const agentFn = async (
        promptValue: unknown,
        optsValue: unknown = {},
        invocationSignal?: AbortSignal,
      ): Promise<ScriptAgentResult> => {
        const index = ++agentCounter;
        const opts: AgentCallOptions =
          optsValue && typeof optsValue === "object"
            ? (optsValue as AgentCallOptions)
            : {};
        const requestedLabel =
          typeof opts.label === "string" ? sanitizeLine(opts.label, 160) : "";
        const label = requestedLabel || `agent-${index}`;

        if (runSettled || controller.signal.aborted) {
          return {
            ok: false,
            output: "",
            error: "Workflow was aborted before this agent started",
          };
        }
        const startedAt = Date.now();
        const callId = `${details.runId}:call:${index}`;
        const record: AgentRecord = {
          index,
          callId,
          invocation: requestInvocation(
            createInvocationIdentity(details.runId, index),
            startedAt,
          ),
          label,
          phase:
            typeof opts.phase === "string"
              ? sanitizeLine(opts.phase, 160) || undefined
              : details.currentPhase,
          state: "running",
          model: ctx.model?.id,
          contextWindow: ctx.model?.contextWindow,
          startedAt,
          preview: "",
          usage: emptyUsage(),
          transcript: [],
        };
        details.agents.push(record);
        refreshWorkflowGraph(details);
        persistence.checkpoint({ immediate: true });
        emit(false);

        const fail = (error: string): ScriptAgentResult => {
          if (record.state === "running" && !runSettled) {
            const at = Date.now();
            if (
              record.invocation?.admissionState === "pending" &&
              record.invocation.executionState === "pending"
            ) {
              record.invocation = transitionInvocation(record.invocation, {
                status: "rejected",
                at,
              });
            } else if (
              record.invocation?.admissionState === "claimed" &&
              record.invocation.executionState === "running"
            ) {
              record.invocation = transitionInvocation(record.invocation, {
                status: "settled",
                outcome: "error",
                at,
              });
            } else if (
              record.invocation &&
              record.invocation.executionState !== "settled" &&
              record.invocation.executionState !== "uncertain"
            ) {
              record.invocation = classifyInterruptedInvocation(
                record.invocation,
                at,
              );
            }
            record.state = "error";
            record.error = sanitizeWorkflowDisplayLine(error);
            record.finishedAt = at;
            emit();
          }
          return { ok: false, output: "", error };
        };

        const basePrompt =
          typeof promptValue === "string"
            ? promptValue
            : String(promptValue ?? "");
        if (!basePrompt.trim())
          return fail("agent() requires a non-empty prompt string");

        let operatorKey: string | undefined;
        try {
          if (opts.operator !== undefined) {
            operatorKey = normalizeWorkflowOperatorKey(String(opts.operator));
            if (opts.isolation !== undefined) {
              throw new Error(
                "workflow operators cannot use per-call worktree isolation",
              );
            }
            record.operatorKey = operatorKey;
          }
        } catch (error) {
          return fail(`agent "${label}": ${errorText(error)}`);
        }

        let inputRefs: string[] = [];
        let promptWithHandoffs = basePrompt;
        try {
          if (opts.inputs !== undefined) {
            if (
              !Array.isArray(opts.inputs) ||
              !opts.inputs.every((value) => typeof value === "string")
            ) {
              throw new Error(
                "inputs must be an array of workflow result refs",
              );
            }
            inputRefs = [...opts.inputs];
          }
          const entries = handoffs.resolveEntries(inputRefs);
          record.inputCallIds = entries.flatMap((entry) =>
            entry.callId ? [entry.callId] : [],
          );
          promptWithHandoffs = handoffs.appendToPrompt(basePrompt, inputRefs);
        } catch (error) {
          return fail(`agent "${label}": ${errorText(error)}`);
        }

        let acceptanceContract: ReturnType<typeof parseAcceptanceContract>;
        let effectiveSchema: unknown;
        try {
          acceptanceContract = parseAcceptanceContract(opts.acceptance);
          effectiveSchema = acceptanceContract
            ? acceptanceSchema(opts.schema, acceptanceContract)
            : opts.schema;
        } catch (error) {
          return fail(`agent "${label}": ${errorText(error)}`);
        }
        const prompt = buildWorkflowAgentPrompt(
          acceptanceContract
            ? `${promptWithHandoffs}\n\n${acceptanceInstruction(acceptanceContract)}`
            : promptWithHandoffs,
        );
        if (controller.signal.aborted)
          return fail("Workflow was aborted before this agent started");

        const requestedType =
          typeof opts.agent_type === "string"
            ? opts.agent_type.trim()
            : undefined;
        if (opts.agent_type !== undefined && !requestedType) {
          return fail(
            `agent "${label}": agent_type must be a non-empty string`,
          );
        }
        const agentType = requestedType
          ? runAgentTypes.get(requestedType)
          : undefined;
        if (requestedType && !agentType) {
          return fail(
            `agent "${label}": unknown agent_type "${requestedType}" (available: ${[...runAgentTypes.keys()].join(", ")})`,
          );
        }

        const explicitModel =
          typeof opts.model === "string" && opts.model.trim()
            ? opts.model.trim()
            : undefined;
        const explicitProvider =
          typeof opts.provider === "string" && opts.provider.trim()
            ? opts.provider.trim()
            : undefined;
        if (opts.model !== undefined && !explicitModel) {
          return fail(`agent "${label}": model must be a non-empty string`);
        }
        if (opts.provider !== undefined && !explicitProvider) {
          return fail(`agent "${label}": provider must be a non-empty string`);
        }
        if (explicitProvider && !explicitModel) {
          return fail(
            `agent "${label}": \`provider\` requires \`model\` as well`,
          );
        }

        const explicitModelHint =
          explicitModel && explicitProvider
            ? `${explicitProvider}/${explicitModel}`
            : explicitModel;
        const modelHint = selectSubagentModel(
          explicitModelHint,
          agentType,
          roleModelForAgentType(
            agentType,
            loadSetupConfig().subagents.roleModels,
          ),
        );
        const explicitEffort =
          typeof opts.effort === "string" && opts.effort.trim()
            ? opts.effort.trim()
            : undefined;
        if (opts.effort !== undefined && !explicitEffort) {
          return fail(`agent "${label}": effort must be a non-empty string`);
        }
        // Resolve every output-affecting default before replay lookup.
        let model: WorkflowModel | undefined = ctx.model;
        if (modelHint !== undefined) {
          try {
            model = resolveAgentModel(
              ctx.modelRegistry,
              modelHint,
              ctx.model
                ? { provider: ctx.model.provider, id: ctx.model.id }
                : undefined,
            );
          } catch (error) {
            return fail(`agent "${label}": ${errorText(error)}`);
          }
        }
        const effectiveEffort = explicitEffort ?? agentType?.reasoningEffort;
        let thinkingLevel: ThinkingLevel = pi.getThinkingLevel();
        if (effectiveEffort !== undefined) {
          const effort = String(effectiveEffort);
          if (!(THINKING_LEVELS as readonly string[]).includes(effort)) {
            return fail(
              `agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`,
            );
          }
          thinkingLevel = effort as ThinkingLevel;
        }
        record.model = model?.id;
        record.contextWindow = model?.contextWindow;
        const operatorFingerprint = operatorKey
          ? agentCallKey("workflow-operator", {
              execution: {
                agentType: agentType
                  ? {
                      name: agentType.name,
                      body: agentType.body,
                      tools: agentType.tools,
                    }
                  : undefined,
                model: model ? `${model.provider}/${model.id}` : undefined,
                effort: thinkingLevel,
                structured: effectiveSchema !== undefined,
              },
            })
          : undefined;

        // Replay is deliberately narrower than execution: only a named type
        // whose effective tool allowlist is entirely known read-only can be
        // cached. General-purpose children inherit bash/edit/write, custom
        // tools have unknown effects, and worktrees have state a string result
        // cannot restore.
        // A reused operator's later activation depends on prior in-memory
        // conversation state, which a cached string cannot reconstruct.
        const replaySafe =
          operatorKey === undefined &&
          isReplaySafeAgentCall({
            tools: agentType?.tools,
            isolation: opts.isolation,
          });
        const replayLease = beginProcessReplayWorkspaceLease(replaySafe);
        let replayResources:
          | Awaited<ReturnType<typeof getResources>>
          | undefined;
        let replayIdentity: ReturnType<typeof createReplayIdentity> | undefined;
        if (replaySafe) {
          try {
            replayResources = await getResources(
              effectiveSchema !== undefined,
              ctx.cwd,
              agentType?.body,
            );
            replayIdentity = createReplayIdentity(
              ctx.cwd,
              replayResources.loader,
              projectTrusted,
            );
          } catch {
            // Fingerprinting is an optimization boundary. If resources cannot
            // be resolved, run normally and let the execution path report any
            // real resource error instead of trusting an unverifiable hit.
          }
        }
        const replayKey = (
          identity: NonNullable<ReturnType<typeof createReplayIdentity>>,
        ) =>
          agentCallKey(prompt, {
            ...opts,
            execution: {
              agentType: agentType
                ? {
                    name: agentType.name,
                    body: agentType.body,
                    tools: agentType.tools,
                  }
                : undefined,
              model: model ? `${model.provider}/${model.id}` : undefined,
              effort: thinkingLevel,
              acceptance: acceptanceContract,
              replayIdentity: identity,
            },
          });
        const callKey = replayIdentity ? replayKey(replayIdentity) : undefined;
        let replayBoundaryViolated = false;
        // Checked before controller.schedule on purpose: schedule() charges the
        // run's agent-call budget on entry, and a replayed call runs no agent.
        const cached =
          callKey && replayLease.canReplay ? replay?.take(callKey) : undefined;
        if (cached) {
          const finishedAt = Date.now();
          record.invocation = transitionInvocation(record.invocation!, {
            status: "replayed",
            at: finishedAt,
          });
          record.state = "done";
          record.replayed = true;
          record.finishedAt = finishedAt;
          record.preview = sanitizeWorkflowDisplayText(
            cached.output,
            PREVIEW_LENGTH,
          );
          if (acceptanceContract) {
            record.acceptance = evaluateAcceptance(
              acceptanceContract,
              cached.structured,
            );
          }
          const ref = handoffs.register({
            callId,
            settled: true,
            ok: true,
            output: cached.output,
            ...(cached.structured !== undefined
              ? { structured: cached.structured }
              : {}),
          });
          if (ref) record.resultRef = ref;
          emit();
          // Re-journal so a chain of resumes keeps working: run C resuming from
          // B still finds what B replayed from A.
          journalEntries.push(cached);
          replayLease.end();
          return {
            ok: true,
            output: cached.output,
            ...(cached.structured !== undefined
              ? { structured: cached.structured }
              : {}),
            ...(ref ? { ref } : {}),
            ...(record.acceptance ? { acceptance: record.acceptance } : {}),
          };
        }

        return controller
          .schedule(async (runSignal) => {
            const claimedAt = Date.now();
            record.invocation = transitionInvocation(record.invocation!, {
              status: "claimed",
              at: claimedAt,
            });
            refreshWorkflowGraph(details);
            persistence.checkpoint({ immediate: true });
            record.invocation = transitionInvocation(record.invocation, {
              status: "running",
              at: Date.now(),
            });
            record.model = model?.id;
            record.contextWindow = model?.contextWindow;
            emit();

            /**
             * Isolation is requested, not best-effort: the caller asks for a
             * worktree exactly because concurrent stages would otherwise
             * collide in one checkout, so silently sharing `ctx.cwd` would
             * hand back the hazard they were avoiding. Fail this one agent
             * with git's reason; siblings are unaffected.
             */
            let worktree: Worktree | undefined;
            if (opts.isolation !== undefined) {
              if (opts.isolation !== "worktree") {
                return fail(
                  `agent "${label}": invalid isolation "${String(opts.isolation)}" (the only value is "worktree")`,
                );
              }
              const created = await createWorktree({
                cwd: ctx.cwd,
                label,
                id: `${details.runId}-${record.index}`,
              });
              if (!created.ok) {
                return fail(
                  `agent "${label}": isolation "worktree" requested but could not be created (${created.reason})`,
                );
              }
              worktree = created.worktree;
              if (!runSettled) record.worktreeBranch = worktree.branch;
            }
            if (runSignal.aborted || runSettled) {
              throw runSignal.reason instanceof Error
                ? runSignal.reason
                : new Error("Workflow was aborted");
            }
            const agentCwd = worktree?.path ?? ctx.cwd;

            // Inside the try, not before it: building resources can throw
            // (bad settings, an unreadable skills dir), and a throw out here
            // would skip the finally and leak the worktree permanently —
            // nothing sweeps `.git/pi-worktrees/` afterwards.
            try {
              let rejectResourceLoad: (() => void) | undefined;
              const resourceAbort = new Promise<never>((_resolve, reject) => {
                rejectResourceLoad = () =>
                  reject(
                    runSignal.reason instanceof Error
                      ? runSignal.reason
                      : new Error("Workflow was aborted"),
                  );
                runSignal.addEventListener("abort", rejectResourceLoad, {
                  once: true,
                });
                if (runSignal.aborted) queueMicrotask(rejectResourceLoad);
              });
              const resources = await Promise.race([
                replayResources ??
                  getResources(
                    effectiveSchema !== undefined,
                    agentCwd,
                    agentType?.body,
                  ),
                resourceAbort,
              ]).finally(() => {
                if (rejectResourceLoad) {
                  runSignal.removeEventListener("abort", rejectResourceLoad);
                }
              });
              if (runSettled) {
                throw new Error("Workflow was settled before agent creation");
              }
              const runChild = (sessionManager?: SessionManager) =>
                runAgent({
                  prompt,
                  schema: effectiveSchema,
                  model,
                  thinkingLevel,
                  // Replay-safe calls use the same canonical cwd as the
                  // identity and filesystem boundary, so a symlink spelling of
                  // the checkout cannot retarget relative tool paths.
                  cwd: replayIdentity?.cwd ?? agentCwd,
                  loader: resources.loader,
                  settingsManager: resources.settingsManager,
                  ...(sessionManager ? { sessionManager } : {}),
                  modelRegistry: ctx.modelRegistry,
                  ...(agentType?.tools ? { tools: agentType.tools } : {}),
                  ...(replayIdentity
                    ? {
                        replayFilesystemBoundary: {
                          repositoryRoot: replayIdentity.repositoryRoot,
                          cwd: replayIdentity.cwd,
                          onViolation: () => {
                            replayBoundaryViolated = true;
                          },
                        },
                      }
                    : {}),
                  signal: runSignal,
                  onProgress: (progress) => {
                    if (runSettled || record.state !== "running") return;
                    record.preview = sanitizeWorkflowDisplayText(
                      progress.preview,
                      PREVIEW_LENGTH,
                    );
                    record.usage = progress.usage;
                    record.model = progress.model ?? record.model;
                    record.contextWindow =
                      progress.contextWindow ?? record.contextWindow;
                    record.transcript = progress.transcript;
                    emit();
                  },
                });
              const outcome = operatorKey
                ? await operators.activate(
                    {
                      key: operatorKey,
                      fingerprint: operatorFingerprint!,
                      cwd: agentCwd,
                      signal: runSignal,
                    },
                    runChild,
                  )
                : await runChild();

              if (runSettled || record.state !== "running") {
                return {
                  ok: false,
                  output: "",
                  error: "Agent completed after workflow settlement",
                };
              }
              record.usage = outcome.usage;
              record.model = outcome.model ?? record.model;
              record.contextWindow =
                outcome.contextWindow ?? record.contextWindow;
              record.transcript = outcome.transcript;
              record.preview = sanitizeWorkflowDisplayText(
                outcome.output || record.preview,
                PREVIEW_LENGTH,
              );
              const finishedAt = Date.now();
              record.finishedAt = finishedAt;
              const judged = applyAcceptance({
                contract: acceptanceContract,
                structured: outcome.structured,
                agentOk: outcome.ok,
                ...(outcome.error ? { agentError: outcome.error } : {}),
              });
              const acceptance = judged.ledger;
              if (acceptance) record.acceptance = acceptance;
              const outcomeOk = judged.ok;
              record.invocation = transitionInvocation(record.invocation!, {
                status: "settled",
                outcome: outcomeOk ? "success" : "error",
                at: finishedAt,
              });
              record.state = outcomeOk ? "done" : "error";
              if (outcomeOk) delete record.error;
              else
                record.error = judged.error
                  ? sanitizeWorkflowDisplayLine(judged.error)
                  : undefined;
              const ref = handoffs.register({
                callId,
                settled: true,
                ok: outcomeOk,
                output: outcome.output,
                ...(outcome.structured !== undefined
                  ? { structured: outcome.structured }
                  : {}),
              });
              if (ref) record.resultRef = ref;
              emit();

              // Only provably read-only successes with a complete, stable
              // identity are journaled. Recheck after execution so a concurrent
              // writer cannot leave a result keyed to the state from before it
              // ran. Re-running a failure is usually why someone resumes;
              // writable, unrestricted, unknown-tool, isolated, changed, and
              // unfingerprintable calls always run for real.
              const completedIdentity = callKey
                ? createReplayIdentity(
                    ctx.cwd,
                    resources.loader,
                    projectTrusted,
                  )
                : undefined;
              const completedKey = completedIdentity
                ? replayKey(completedIdentity)
                : undefined;
              if (
                !runSettled &&
                outcomeOk &&
                completedKey !== undefined &&
                completedKey === callKey &&
                !replayBoundaryViolated &&
                replayLease.canJournal()
              ) {
                journalEntries.push({
                  key: completedKey,
                  output: outcome.output,
                  ...(outcome.structured !== undefined
                    ? { structured: outcome.structured }
                    : {}),
                });
              }

              return {
                ok: outcomeOk,
                output: outcome.output,
                ...(outcome.structured !== undefined
                  ? { structured: outcome.structured }
                  : {}),
                ...(ref ? { ref } : {}),
                ...(acceptance ? { acceptance } : {}),
                ...(record.error !== undefined ? { error: record.error } : {}),
              };
            } finally {
              // Reclaim as this agent settles, not at run end: a pipeline can
              // hold many worktrees open at once. Cleanup must never turn a
              // finished agent into a failed one, so failures only downgrade
              // what we report about the worktree.
              if (worktree) {
                const prepared = prepareWorktreeHandoff({
                  runDir,
                  runId: details.runId,
                  agentIndex: record.index,
                  agentLabel: record.label,
                  repoCwd: ctx.cwd,
                  worktree,
                });
                let cleanup: WorktreeCleanup;
                if (!prepared.ok) {
                  cleanup = {
                    removed: false,
                    branchDeleted: false,
                    reason: `handoff capture failed; preserved checkout: ${prepared.reason}`,
                    branch: worktree.branch,
                    ...(worktree.baseSha ? { baseSha: worktree.baseSha } : {}),
                    detached: false,
                  };
                } else {
                  cleanup = await reclaimWorktree(ctx.cwd, worktree).catch(
                    (error): WorktreeCleanup => ({
                      removed: false,
                      branchDeleted: false,
                      reason: `worktree cleanup failed: ${errorText(error)}`,
                      branch: worktree.branch,
                      ...(worktree.baseSha
                        ? { baseSha: worktree.baseSha }
                        : {}),
                      detached: false,
                    }),
                  );
                  try {
                    finalizeWorktreeHandoff(prepared, cleanup);
                    record.worktreeHandoffArtifact = prepared.artifact;
                  } catch (error) {
                    cleanup = {
                      ...cleanup,
                      reason: `handoff finalization failed: ${errorText(error)}${cleanup.reason ? `; ${cleanup.reason}` : ""}`,
                    };
                  }
                }
                if (!runSettled) {
                  record.worktreeCleanup = cleanup;
                  if (cleanup.branchDeleted) delete record.worktreeBranch;
                  else record.worktreeBranch = cleanup.branch;
                  if (!cleanup.removed) record.worktreePath = worktree.path;
                  emit();
                }
              }
            }
          }, invocationSignal)
          .catch((error) => fail(errorText(error)))
          .finally(() => replayLease.end());
      };

      const runScript = async () => {
        let status: WorkflowDetails["status"] = "completed";
        try {
          const result = await runWorkflowSandbox({
            source: prepared.source,
            args,
            cwd: ctx.cwd,
            signal: controller.signal,
            onAgent: agentFn,
            onPhase: phaseFn,
            onLog: logFn,
            usageSnapshot: readUsage,
            maxConcurrency: workflowConfig.concurrency,
            maxAgentCalls: workflowConfig.maxAgentCalls,
            // Replays send an IPC message but spend no controller budget, so
            // the sandbox's backstop has to know how many to expect.
            extraAgentRequests: replay?.available ?? 0,
          });
          if (!runSettled) details.result = result;
        } catch (error) {
          if (!runSettled) {
            details.error = errorText(error);
            status = controller.signal.aborted ? "aborted" : "failed";
            controller.abort("Workflow script failed");
          }
        }

        const settled = await controller.settle({
          abort: status !== "completed",
        });
        const operatorsSettled = await waitBounded(operators.close(), 1_000);
        if (runSettled) return;
        if (!settled || !operatorsSettled) {
          status = "failed";
          const cleanupError = !settled
            ? "agent shutdown deadline exceeded"
            : "workflow operator cleanup deadline exceeded";
          details.error = details.error
            ? `${details.error}; ${cleanupError}`
            : cleanupError[0]!.toUpperCase() + cleanupError.slice(1);
        }
        if (runSettled) return;
        terminalize(status, details.error);
        try {
          persistence.flush();
        } catch (error) {
          details.status = "failed";
          details.error = `Artifact persistence failed: ${errorText(error)}`;
          throw new Error(details.error);
        } finally {
          flushNow(true);
        }
      };

      // Registered for /workflows visibility and session_shutdown abort;
      // blocking runs are watchable live from the dashboard too.
      const activeRun: ActiveWorkflowRunLifecycle = {
        details,
        controller,
        forceSettle,
      };
      activeRuns.set(runId, activeRun);
      const completion = runScript();
      activeRun.completion = completion;
      if (ctx.hasUI) lastContext = ctx;
      updateIndicator();

      if (background) {
        void completion
          .catch((error) => {
            details.status = "failed";
            details.finishedAt = Date.now();
            details.error = details.error ?? errorText(error);
          })
          .finally(() => {
            activeRuns.delete(runId);
            recordSettledRun(details);
            updateIndicator();
            try {
              // Deliver like the subagent/terminal families: a custom-typed
              // session message with a dedicated renderer, not a plain
              // user-provenance turn.
              //
              // Wake the model only if it is idle and therefore plausibly
              // waiting on this run. If it is busy with something else, the
              // result still enters context with the user's next message
              // (nextTurn) instead of forcing a turn it can only acknowledge.
              const wake = ctx.isIdle();
              pi.sendMessage(
                {
                  customType: "workflow-result",
                  content: buildBackgroundWorkflowFollowUp({
                    runId,
                    name: details.name,
                    status: details.status,
                    result: buildWorkflowResultMessage(details, runDir),
                  }),
                  display: true,
                  details: compactToolDetails(details),
                },
                wake
                  ? { deliverAs: "followUp", triggerTurn: true }
                  : { deliverAs: "nextTurn" },
              );
            } catch {
              // Session may be shutting down.
            }
          });
        return {
          content: [
            {
              type: "text",
              text: buildBackgroundWorkflowLaunchResult({
                runId,
                name: details.name,
                runDir,
              }),
            },
          ],
          details: compactToolDetails(details),
        };
      }

      try {
        await completion;
      } finally {
        activeRuns.delete(runId);
        recordSettledRun(details);
        updateIndicator();
      }
      if (details.status !== "completed") {
        // Pi marks tool failures only when execute throws; returning isError is
        // ignored by the extension API.
        throw new Error(buildWorkflowResultMessage(details, runDir));
      }
      return {
        content: [
          {
            type: "text",
            text: buildWorkflowResultMessage(details, runDir),
          },
        ],
        details: compactToolDetails(details),
      };
    },

    renderCall(args: Partial<WorkflowInput>, theme) {
      const meta =
        typeof args.script === "string"
          ? extractMeta(args.script)
          : { phases: [] };
      let text =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", (meta as WorkflowMeta).name ?? "(script)");
      if (args.background) text += theme.fg("dim", " (background)");
      const description = (meta as WorkflowMeta).description;
      if (description) text += `\n  ${theme.fg("dim", description)}`;
      for (const phase of meta.phases.slice(0, 8)) {
        text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
          phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
        }`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as WorkflowDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }

      const { done, failed } = countStates(details);
      const settled = done + failed;
      const elapsed = formatElapsed(details.startedAt, details.finishedAt);
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg(
          "accent",
          sanitizeWorkflowDisplayLine(details.name ?? details.runId),
        )} ` +
        theme.fg(
          "dim",
          `${settled}/${details.agents.length} agents · ${elapsed} · `,
        ) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (details.background) header += theme.fg("dim", " (background)");
      if (details.status === "running" && details.currentPhase) {
        header += theme.fg(
          "muted",
          ` · ${sanitizeWorkflowDisplayLine(details.currentPhase)}`,
        );
      }
      const totals = formatUsage(aggregateUsage(details.agents));

      if (!expanded) {
        let text = header;
        for (const agent of details.agents) {
          const context = agentContext(agent);
          text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg(
            "accent",
            sanitizeWorkflowDisplayLine(agent.label),
          )}${
            agent.phase
              ? theme.fg(
                  "dim",
                  ` (${sanitizeWorkflowDisplayLine(agent.phase)})`,
                )
              : ""
          }${theme.fg(
            "dim",
            `${context ? ` · ${context}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`,
          )}`;
        }
        // Only the tail collapsed: the newest lines are the ones that say
        // where the run is now.
        for (const entry of (details.logs ?? []).slice(-3)) {
          text += `\n  ${theme.fg("muted", "›")} ${theme.fg(
            "dim",
            sanitizeWorkflowDisplayLine(entry.text),
          )}`;
        }
        if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
        if (details.error)
          text += `\n  ${theme.fg(
            "error",
            `Error: ${sanitizeWorkflowDisplayLine(details.error)}`,
          )}`;
        text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      if (details.description) {
        container.addChild(
          new Text(
            theme.fg("dim", sanitizeWorkflowDisplayLine(details.description)),
            0,
            0,
          ),
        );
      }

      for (const group of phaseGroups(details)) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg(
              "muted",
              `─── ${sanitizeWorkflowDisplayLine(group.title)} ───`,
            ),
            0,
            0,
          ),
        );
        for (const agent of group.agents) {
          const usage = formatUsage(agent.usage, agent.model);
          const context = agentContext(agent);
          let line = `${stateSquare(agent.state, theme)} ${theme.fg(
            "accent",
            sanitizeWorkflowDisplayLine(agent.label),
          )} ${theme.fg(
            "dim",
            [context, formatElapsed(agent.startedAt, agent.finishedAt)]
              .filter(Boolean)
              .join(" · "),
          )}`;
          if (usage)
            line += ` ${theme.fg("dim", sanitizeWorkflowDisplayLine(usage))}`;
          container.addChild(new Text(line, 0, 0));
          if (agent.error) {
            container.addChild(
              new Text(
                `  ${theme.fg("error", sanitizeWorkflowDisplayLine(agent.error))}`,
                0,
                0,
              ),
            );
          } else if (agent.preview) {
            const preview = sanitizeWorkflowDisplayText(
              agent.preview,
              PREVIEW_LENGTH,
            )
              .split("\n")
              .slice(0, 2)
              .join(" ");
            container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
          }
        }
      }

      if (details.logs && details.logs.length > 0) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── log ───"), 0, 0));
        if (details.logsDropped) {
          container.addChild(
            new Text(
              theme.fg(
                "dim",
                `(${details.logsDropped} earlier line(s) dropped)`,
              ),
              0,
              0,
            ),
          );
        }
        for (const entry of details.logs) {
          container.addChild(
            new Text(
              `${theme.fg("muted", "›")} ${theme.fg(
                "dim",
                sanitizeWorkflowDisplayLine(entry.text),
              )}`,
              0,
              0,
            ),
          );
        }
      }

      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg(
              "error",
              `Error: ${sanitizeWorkflowDisplayLine(details.error)}`,
            ),
            0,
            0,
          ),
        );
      }

      if (details.result !== undefined) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
        container.addChild(
          new Markdown(
            `\`\`\`json\n${resultJson(details.result)}\n\`\`\``,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
      }

      if (totals) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
      }
      return container;
    },
  });

  /** Resolve one run from live, settled, or persisted state. */
  const resolveRunDetails = (target: string) => {
    const base = path.join(getAgentDir(), "workflows");
    let persistedIds: string[] = [];
    try {
      persistedIds = fs.readdirSync(base).filter(isWorkflowRunId);
    } catch {
      // In-memory runs remain inspectable without the artifact directory.
    }
    const resolution = resolveWorkflowRunTarget(target, [
      ...activeRuns.keys(),
      ...settledRuns.keys(),
      ...persistedIds,
    ]);
    if (!resolution.ok) return resolution;

    const active = activeRuns.get(resolution.runId);
    if (active) return { ok: true, details: active.details } as const;
    const settled = settledRuns.get(resolution.runId);
    if (settled) return { ok: true, details: settled } as const;

    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(
          path.join(base, resolution.runId, "workflow.json"),
          "utf8",
        ),
      );
      const details = normalizePersistedWorkflowDetails(
        resolution.runId,
        parsed,
      );
      if (!details) throw new Error("invalid workflow details");
      // A run absent from activeRuns cannot still be running this session; a
      // persisted "running" is a run that was hard-killed or missed the
      // shutdown settle deadline.
      return {
        ok: true,
        details: recoverStaleWorkflowDetails(details),
      } as const;
    } catch {
      return {
        ok: false,
        error: `Workflow run ${resolution.runId} could not be read.`,
      } as const;
    }
  };

  pi.registerTool({
    name: "workflow_stop",
    label: "Stop Workflow",
    description: WORKFLOW_STOP_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_LIFECYCLE_PROMPT_SNIPPET,
    parameters: Type.Object({
      runId: Type.String({
        description: WORKFLOW_STOP_PARAMETER_DESCRIPTIONS.runId,
      }),
    }),
    execute(_toolCallId, params) {
      const running = [...activeRuns].filter(
        ([, run]) => run.details.status === "running",
      );
      const resolution = resolveWorkflowRunTarget(
        params.runId,
        running.map(([runId]) => runId),
      );
      if (!resolution.ok) throw new Error(resolution.error);
      stopRun(resolution.runId);
      return Promise.resolve({
        content: [
          {
            type: "text",
            text: `Stopping workflow ${resolution.runId}.`,
          },
        ],
        details: { runId: resolution.runId, status: "aborting" },
      });
    },
  });

  pi.registerTool({
    name: "workflow_status",
    label: "Workflow Status",
    description: WORKFLOW_STATUS_TOOL_DESCRIPTION,
    parameters: Type.Object({
      runId: Type.Optional(
        Type.String({
          description: WORKFLOW_STATUS_PARAMETER_DESCRIPTIONS.runId,
        }),
      ),
    }),
    execute(_toolCallId, params) {
      // Details are a uniform run-summary array (one entry for a single-id peek)
      // so the tool has a single result shape; the text carries the detail.
      const summarize = (d: WorkflowDetails) => {
        const { done, failed } = countStates(d);
        return {
          runId: d.runId,
          name: d.name,
          status: d.status,
          done,
          failed,
          total: d.agents.length,
        };
      };
      if (params.runId) {
        const resolution = resolveRunDetails(params.runId);
        if (!resolution.ok) throw new Error(resolution.error);
        const details = resolution.details;
        const runDir = path.join(getAgentDir(), "workflows", details.runId);
        return Promise.resolve({
          content: [
            { type: "text", text: buildWorkflowResultMessage(details, runDir) },
          ],
          details: { runs: [summarize(details)] },
        });
      }
      const runs = [
        ...[...activeRuns.values()].map((run) => run.details),
        ...settledRuns.values(),
      ];
      if (runs.length === 0) {
        return Promise.resolve({
          content: [
            { type: "text", text: "No active or recently finished workflows." },
          ],
          details: { runs: [] },
        });
      }
      const lines = runs.map((d) => {
        const { done, failed } = countStates(d);
        return `${d.runId}${d.name ? ` "${d.name}"` : ""} — ${statusWord(d.status)} · ${done + failed}/${d.agents.length} agents${failed ? `, ${failed} failed` : ""}`;
      });
      return Promise.resolve({
        content: [{ type: "text", text: lines.join("\n") }],
        details: { runs: runs.map(summarize) },
      });
    },
  });

  pi.registerMessageRenderer(
    "workflow-result",
    (message, { expanded }, theme) => {
      const details = message.details as WorkflowDetails | undefined;
      const body =
        typeof message.content === "string"
          ? message.content
          : (message.content
              ?.map((part) => (part.type === "text" ? part.text : ""))
              .join("") ?? "");
      const safeBody = sanitizeWorkflowDisplayText(body);
      if (!details) return new Text(safeBody, 0, 0);
      const { done, failed } = countStates(details);
      const settled = done + failed;
      let header =
        `${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
        `${theme.fg(
          "accent",
          sanitizeWorkflowDisplayLine(details.name ?? details.runId),
        )} ` +
        theme.fg("dim", `${settled}/${details.agents.length} agents · `) +
        theme.fg(statusColor(details.status), statusWord(details.status));
      if (failed) header += theme.fg("error", ` · ${failed} failed`);
      if (expanded) return new Text(`${header}\n\n${safeBody}`, 0, 0);
      const preview = safeBody.split("\n").slice(0, 8).join("\n");
      return new Text(
        `${header}\n${preview}\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`,
        0,
        0,
      );
    },
  );
}
