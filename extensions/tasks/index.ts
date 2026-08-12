import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  TASKS_ENTRY_TYPE,
  TASKS_LIMITS,
  TASK_STATUSES,
  TaskRestoreError,
  applyTaskAdd,
  applyTaskUpdate,
  createSessionTasks,
  emptyTaskSnapshot,
  projectTasks,
  restoreTaskSnapshot,
  type TaskFilter,
  type TaskItem,
  type TaskSnapshot,
} from "./tasks.ts";
import {
  openTasksScreen,
  TASK_WIDGET_LIMIT,
  renderTaskWidget,
  renderToolResult,
  taskCounts,
  type TaskToolDetails,
} from "./ui.ts";
import { getTaskWidgetAttachment } from "../shared/task-widget-attachment.ts";

const TOOL_NAMES = ["tasks_add", "tasks_update", "tasks_list"] as const;
const TASK_WIDGET_KEY = "session-tasks-panel";
const CONFLICT_NAMES = new Set(["todo", "TodoWrite", "update_plan"]);
const TOOL_PURPOSE =
  "Records session work intent. It does not execute, schedule, or delegate work.";

export interface TaskConflict {
  name: string;
  source?: string;
}

export function findTaskConflict(tools: readonly ToolInfo[]) {
  const conflict = tools.find((tool) => CONFLICT_NAMES.has(tool.name));
  if (!conflict) return undefined;
  const source = conflict.sourceInfo?.path || conflict.sourceInfo?.source;
  return { name: conflict.name, source } satisfies TaskConflict;
}

export function injectTaskProjection(
  messages: readonly unknown[],
  projection: string,
) {
  // Keep this pure for direct tests. Pi already supplies the context hook a
  // deep copy, so this is defensive rather than required by the runtime.
  const next = structuredClone(messages) as Array<{
    role?: string;
    content?: unknown;
  }>;
  for (let index = next.length - 1; index >= 0; index--) {
    const message = next[index];
    if (message.role !== "user") continue;
    const safeProjection = projection
      .replaceAll("<session-tasks>", "[session-tasks]")
      .replaceAll("</session-tasks>", "[/session-tasks]");
    const block = {
      type: "text",
      text: `\n\n<session-tasks>\n${safeProjection}\n</session-tasks>`,
    };
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }, block];
    } else if (Array.isArray(message.content)) {
      message.content.push(block);
    } else {
      return undefined;
    }
    return next;
  }
  return undefined;
}

export function taskConflictMessage(conflict: TaskConflict) {
  return `Session tasks disabled because tool “${conflict.name}” is already registered${conflict.source ? ` by ${conflict.source}` : ""}. Disable the other Todo/plan extension and run /reload.`;
}

export default function sessionTasks(pi: ExtensionAPI) {
  let tasks = createSessionTasks();
  let lockedReason: string | undefined;
  let conflict: TaskConflict | undefined;
  let toolsRegistered = false;
  let coldRun = true;
  let activeRun = false;
  let frozenProjection = "";
  let notifiedProblem: string | undefined;
  let taskWidgetVisible = true;
  let taskWidgetExpanded = false;
  let ui: ExtensionContext["ui"] | undefined;
  let uiMode: ExtensionContext["mode"] | undefined;

  const snapshot = () => tasks.snapshot();

  const actionableTaskCount = () =>
    snapshot().items.filter(
      (item) =>
        item.status === "pending" ||
        item.status === "in_progress" ||
        item.status === "blocked",
    ).length;

  const hasActionableTasks = () => actionableTaskCount() > 0;

  const updateTaskWidget = (ctx?: ExtensionContext) => {
    if (ctx?.hasUI) {
      ui = ctx.ui;
      uiMode = ctx.mode;
    }
    if (!ui || uiMode !== "tui") return false;
    const current = snapshot();
    // The widget also stays up when only a cross-extension reminder is pinned
    // (e.g. multi-signal-sync's completion notice): the notice is what the
    // widget is for at that moment, even with zero open tasks.
    const shown =
      taskWidgetVisible &&
      !problemMessage() &&
      (hasActionableTasks() || getTaskWidgetAttachment() !== undefined);
    if (!shown) {
      ui.setWidget(TASK_WIDGET_KEY, undefined);
      return false;
    }
    ui.setWidget(TASK_WIDGET_KEY, (tui, theme) => {
      // Redraw cadence for the in-flight shimmer sweep: ~8 fps keeps the band
      // advancing about one cell per frame (omp uses 30fps for its loader; the
      // widget is text-only and 8 fps is plenty to read as flowing).
      const timer = setInterval(() => tui.requestRender(), 120);
      timer.unref?.();
      return {
        render: (width) =>
          renderTaskWidget(
            current,
            theme,
            width,
            taskWidgetExpanded,
            Date.now(),
          ),
        invalidate() {},
        dispose() {
          clearInterval(timer);
        },
      };
    });
    return true;
  };

  const taskWidgetFeedback = (shown: boolean) =>
    shown
      ? "Task panel shown."
      : uiMode !== "tui"
        ? "Task panel is available only in interactive TUI mode."
        : taskWidgetVisible
          ? "Task panel enabled; it will appear when active tasks exist."
          : "Task panel hidden.";

  const restore = (ctx: ExtensionContext) => {
    try {
      tasks = createSessionTasks(
        restoreTaskSnapshot(ctx.sessionManager.getBranch()),
      );
      lockedReason = undefined;
    } catch (error) {
      tasks = createSessionTasks(emptyTaskSnapshot());
      lockedReason =
        error instanceof TaskRestoreError || error instanceof Error
          ? error.message
          : String(error);
    }
  };

  const problemMessage = () => {
    if (conflict) return taskConflictMessage(conflict);
    if (lockedReason) {
      return `Session tasks are locked because their newest snapshot is invalid: ${lockedReason}. Navigate to a clean branch or start a new session.`;
    }
    return undefined;
  };

  const notifyProblem = (ctx: ExtensionContext) => {
    const problem = problemMessage();
    if (!problem) {
      notifiedProblem = undefined;
      return;
    }
    if (ctx.hasUI && notifiedProblem !== problem) {
      notifiedProblem = problem;
      ctx.ui.notify(problem, "warning");
    }
  };

  const assertAvailable = () => {
    const problem = problemMessage();
    if (problem) throw new Error(problem);
  };

  const persistThenCommit = (candidate: TaskSnapshot) => {
    if (candidate.revision === snapshot().revision) return false;
    // Keep this path synchronous. An await here would let sibling tool calls
    // reorder state and persistence, recreating the upstream Todo lost-update bug.
    pi.appendEntry(TASKS_ENTRY_TYPE, candidate);
    tasks.commit(candidate);
    updateTaskWidget();
    return true;
  };

  const toolDetails = (
    action: TaskToolDetails["action"],
    items: TaskItem[],
    batchClosed = false,
  ): TaskToolDetails => ({
    action,
    items,
    total: snapshot().items.length,
    revision: snapshot().revision,
    counts: taskCounts(snapshot().items),
    ...(batchClosed ? { batchClosed: true } : {}),
  });

  const mutationResultText = (summary: string) => {
    const current = snapshot();
    return `${summary}\nCurrent task snapshot (${current.items.length} ${current.items.length === 1 ? "item" : "items"}):\n${tasks.render()}`;
  };

  const registerTools = () => {
    if (toolsRegistered || conflict) return;
    toolsRegistered = true;

    pi.registerTool({
      name: "tasks_add",
      label: "Tasks Add",
      description: `${TOOL_PURPOSE} Add one or more stable-ID items to the current Pi session tasks. Use this only for work spanning multiple agent runs or user turns, or for an explicit user task list. When every item in a batch reaches done/dropped the batch closes and the list clears; the next tasks_add starts a fresh batch numbered from T1, so a T-id only identifies work within its own batch (past evidence remains in the session history, not this list).`,
      promptSnippet:
        "Add stable work-intent items to the current session tasks",
      promptGuidelines: [
        "Use tasks_add only for work spanning multiple agent runs or user turns, or when the user explicitly provides a task list; do not use it as a per-step scratchpad within one run.",
        "Before starting each tracked item, call tasks_update to mark it in_progress; concurrent work may have multiple in_progress items.",
        "Task tools record advisory intent only; Subagents and Workflows execute work, while files, git, tests, tool results, artifacts, and user confirmation remain truth.",
      ],
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            subject: Type.String({
              minLength: 1,
              maxLength: TASKS_LIMITS.subjectChars,
              description: "Short imperative description.",
            }),
            detail: Type.Optional(
              Type.String({ maxLength: TASKS_LIMITS.detailChars }),
            ),
          }),
          { minItems: 1, maxItems: TASKS_LIMITS.addBatch },
        ),
      }),
      execute(_id, params) {
        assertAvailable();
        const mutation = applyTaskAdd(snapshot(), params.items);
        persistThenCommit(mutation.snapshot);
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: mutationResultText(
                `Added ${mutation.items.map((item) => `T${item.id}`).join(", ")}.`,
              ),
            },
          ],
          details: toolDetails("add", snapshot().items),
        });
      },
      renderCall(args, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("tasks_add"))} ${theme.fg("muted", `${args.items.length} item(s)`)}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme) {
        const first = result.content[0];
        return renderToolResult(
          result.details,
          options.expanded,
          theme,
          first?.type === "text" ? first.text : "Tasks unavailable.",
        );
      },
    });

    pi.registerTool({
      name: "tasks_update",
      label: "Tasks Update",
      description: `${TOOL_PURPOSE} Patch one task item by numeric ID. blocked, done, and dropped status changes require a fresh note explaining the blocker, observable evidence, or drop reason.`,
      promptSnippet: "Update one session task item by stable ID",
      promptGuidelines: [
        "Immediately after each tracked item reaches a real outcome, call tasks_update to set done, blocked, or dropped before moving to the next tracked item.",
        "Before sending a final answer, reconcile every task touched in the current request; do not leave completed work pending or in_progress.",
        "A commit, passing test, or authorization is task-scoped evidence only; it does not by itself prove a task is done or identify which task to update.",
        "Before setting a task item to done, include a note citing an observable check, artifact, commit, tool result, or user confirmation; Tasks record this claim but do not verify it.",
      ],
      parameters: Type.Object({
        id: Type.Integer({ minimum: 1 }),
        subject: Type.Optional(
          Type.String({ minLength: 1, maxLength: TASKS_LIMITS.subjectChars }),
        ),
        detail: Type.Optional(
          Type.Union([
            Type.String({ maxLength: TASKS_LIMITS.detailChars }),
            Type.Null(),
          ]),
        ),
        status: Type.Optional(StringEnum(TASK_STATUSES)),
        note: Type.Optional(
          Type.Union([
            Type.String({ maxLength: TASKS_LIMITS.noteChars }),
            Type.Null(),
          ]),
        ),
      }),
      execute(_id, params) {
        assertAvailable();
        const before = snapshot();
        const closesBatch = mutationWillCloseBatch(
          before,
          params.id,
          params.status,
        );
        const mutation = applyTaskUpdate(before, params);
        const changed = persistThenCommit(mutation.snapshot);
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: mutationResultText(
                changed
                  ? closesBatch
                    ? `${params.status === "dropped" ? "Dropped" : "Completed"} T${params.id}. Task batch closed; the next tasks_add starts again at T1.`
                    : `Updated T${params.id}.`
                  : `T${params.id} already has that state; no update recorded.`,
              ),
            },
          ],
          details: toolDetails("update", snapshot().items, closesBatch),
        });
      },
      renderCall(args, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("tasks_update"))} ${theme.fg("accent", `T${args.id}`)}${args.status ? ` ${theme.fg("muted", args.status)}` : ""}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme) {
        const first = result.content[0];
        return renderToolResult(
          result.details,
          options.expanded,
          theme,
          first?.type === "text" ? first.text : "Tasks unavailable.",
        );
      },
    });

    pi.registerTool({
      name: "tasks_list",
      label: "Tasks List",
      description:
        "Reads the current session's work-intent tasks, optionally filtered by ID and status; does not execute, schedule, or delegate work.",
      promptSnippet: "List current session work-intent task items",
      parameters: Type.Object({
        id: Type.Optional(Type.Integer({ minimum: 1 })),
        status: Type.Optional(StringEnum(TASK_STATUSES)),
      }),
      execute(_id, params) {
        assertAvailable();
        const filter = params satisfies TaskFilter;
        const items = tasks.list(filter);
        const preview = items.slice(0, 5);
        const rendered = tasks.render(filter, 3_800);
        const text =
          rendered.endsWith("…") || items.length > preview.length
            ? `${rendered}\nShowing a bounded view of ${items.length} matched item(s); filter by status or id for a narrower result.`
            : rendered;
        return Promise.resolve({
          content: [{ type: "text" as const, text }],
          details: toolDetails("list", preview),
        });
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold("tasks_list")), 0, 0);
      },
      renderResult(result, options, theme) {
        const first = result.content[0];
        return renderToolResult(
          result.details,
          options.expanded,
          theme,
          first?.type === "text" ? first.text : "Tasks unavailable.",
        );
      },
    });
  };

  pi.registerCommand("tasks", {
    description: "Inspect the current session work-intent tasks",
    handler: async (args, ctx) => {
      const problem = problemMessage();
      if (problem) {
        if (ctx.hasUI) ctx.ui.notify(problem, "warning");
        return;
      }
      const action = args.trim().toLowerCase();
      if (action === "hide" || action === "show" || action === "toggle") {
        taskWidgetVisible =
          action === "show"
            ? true
            : action === "hide"
              ? false
              : !taskWidgetVisible;
        taskWidgetExpanded = false;
        const shown = updateTaskWidget(ctx);
        if (ctx.hasUI) ctx.ui.notify(taskWidgetFeedback(shown), "info");
        return;
      }
      await openTasksScreen(ctx, snapshot());
    },
  });

  pi.registerShortcut(Key.ctrlShift("t"), {
    description: "Show all active tasks above the editor, or collapse to four",
    handler: async (ctx) => {
      const problem = problemMessage();
      if (problem) {
        if (ctx.hasUI) ctx.ui.notify(problem, "warning");
        return;
      }
      const count = actionableTaskCount();
      if (count === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "No active tasks to show. Use /tasks to inspect task history.",
            "info",
          );
        }
        return;
      }
      taskWidgetVisible = true;
      taskWidgetExpanded =
        count > TASK_WIDGET_LIMIT ? !taskWidgetExpanded : false;
      updateTaskWidget(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(
          count <= TASK_WIDGET_LIMIT
            ? `All ${count} active task${count === 1 ? " is" : "s are"} already visible.`
            : taskWidgetExpanded
              ? `Showing all ${count} active tasks above the editor.`
              : `Task panel collapsed to ${TASK_WIDGET_LIMIT} active tasks.`,
          "info",
        );
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
    uiMode = ctx.hasUI ? ctx.mode : undefined;
    restore(ctx);
    conflict = findTaskConflict(pi.getAllTools());
    coldRun = true;
    activeRun = false;
    frozenProjection = "";
    taskWidgetVisible = true;
    taskWidgetExpanded = false;
    registerTools();
    notifyProblem(ctx);
    updateTaskWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    taskWidgetExpanded = false;
    coldRun = true;
    activeRun = false;
    frozenProjection = "";
    notifyProblem(ctx);
    updateTaskWidget(ctx);
  });

  pi.on("session_compact", () => {
    coldRun = true;
    frozenProjection = "";
  });

  pi.on("agent_start", () => {
    activeRun = true;
    if (coldRun) {
      frozenProjection = !problemMessage() ? projectTasks(snapshot()) : "";
      coldRun = false;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    activeRun = false;
    frozenProjection = "";
    notifyBlockedTasks(ctx);
  });

  // Blocked tasks are the one state that needs a human in the loop (owner
  // ruling, missing credential, external wait). The widget shows them with a
  // `!` and the /tasks screen explains them, but neither raises an event — a
  // turn that ends with a blocked task would sit silently until the user
  // happens to look. Each blocked task is announced once per blocked stint;
  // clearing the block (or dropping the task) re-arms it.
  let notifiedBlocked = new Set<number>();
  const notifyBlockedTasks = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const current = snapshot().items;
    const blockedIds = new Set(
      current
        .filter((item) => item.status === "blocked")
        .map((item) => item.id),
    );
    for (const item of current) {
      if (item.status !== "blocked" || notifiedBlocked.has(item.id)) continue;
      notifiedBlocked.add(item.id);
      ctx.ui.notify(
        `T${item.id} blocked: ${item.subject}${item.note ? ` — ${item.note}` : ""} · 需要人工介入`,
        "warning",
      );
    }
    // Re-arm ids that left the blocked state (or the list) so a later
    // re-block announces again.
    for (const id of notifiedBlocked) {
      if (blockedIds.has(id)) continue;
      notifiedBlocked.delete(id);
    }
  };

  pi.on("context", (event) => {
    if (!activeRun || !frozenProjection || problemMessage()) return;
    const messages = injectTaskProjection(event.messages, frozenProjection);
    if (messages) return { messages: messages as typeof event.messages };
  });

  pi.on("session_shutdown", () => {
    try {
      ui?.setWidget(TASK_WIDGET_KEY, undefined);
    } catch {
      // The interactive UI may already be disposed.
    }
    ui = undefined;
    uiMode = undefined;
  });
}

export { TOOL_NAMES as TASK_TOOL_NAMES };

function mutationWillCloseBatch(
  snapshot: TaskSnapshot,
  id: number,
  status: TaskItem["status"] | undefined,
) {
  if (status !== "done" && status !== "dropped") return false;
  return snapshot.items.every(
    (item) =>
      item.id === id || item.status === "done" || item.status === "dropped",
  );
}
