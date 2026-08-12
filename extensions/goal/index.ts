import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { GOAL_CONTINUATION_TYPE, GoalController } from "./controller.ts";
import {
  GOAL_LIMITS,
  canResumeGoal,
  createGoalSnapshot,
  isGoalUnfinished,
  type GoalInput,
  type GoalSnapshot,
} from "./state.ts";
import {
  formatGoalElapsedSeconds,
  formatTokensCompact,
  goalContinuationLabel,
  goalFooterText,
  renderGoalTool,
  statusColor,
  statusLabel,
  truncateGoalObjective,
  type GoalToolDetails,
} from "./ui.ts";

const GOAL_USAGE = "Usage: /goal [<objective>|clear|edit|pause|resume]";
const COMPLETION_BUDGET_REPORT =
  "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language.";

export function parseGoalCommand(args: string) {
  const trimmed = args.trim();
  const control = trimmed.toLowerCase();
  if (!trimmed || control === "status") return { action: "status" as const };
  if (["edit", "pause", "resume", "clear"].includes(control)) {
    return {
      action: control as "edit" | "pause" | "resume" | "clear",
    };
  }
  return { action: "set" as const, objective: trimmed };
}

export function statusText(goal: GoalSnapshot | undefined, problem?: string) {
  if (problem) return `Failed to read goal: ${sanitizeTerminalText(problem)}`;
  if (!goal) return `${GOAL_USAGE}\n\nNo goal is currently set.`;
  const commands =
    goal.status === "active"
      ? "Commands: /goal edit, /goal pause, /goal clear"
      : canResumeGoal(goal)
        ? "Commands: /goal edit, /goal resume, /goal clear"
        : "Commands: /goal edit, /goal clear";
  return [
    "Goal",
    `Status: ${sanitizeTerminalText(statusLabel(goal.status))}`,
    `Objective: ${sanitizeTerminalText(goal.objective)}`,
    `Time used: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}`,
    `Tokens used: ${formatTokensCompact(goal.tokensUsed)}`,
    ...(goal.tokenBudget === undefined
      ? []
      : [`Token budget: ${formatTokensCompact(goal.tokenBudget)}`]),
    "",
    commands,
  ].join("\n");
}

export function goalToolResponse(
  goal: GoalSnapshot | undefined,
  includeCompletionReport = false,
  threadId?: string,
) {
  return {
    goal: goal ? publicGoal(goal, threadId) : null,
    remainingTokens:
      goal?.tokenBudget === undefined
        ? null
        : Math.max(0, goal.tokenBudget - goal.tokensUsed),
    completionBudgetReport:
      includeCompletionReport &&
      goal?.status === "complete" &&
      (goal.tokenBudget !== undefined || goal.timeUsedSeconds > 0)
        ? COMPLETION_BUDGET_REPORT
        : null,
  };
}

export default function sessionGoal(pi: ExtensionAPI) {
  const controller = new GoalController(pi);

  const updateUi = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const goal = controller.footerSnapshot();
    const footer = goal ? goalFooterText(goal) : "";
    ctx.ui.setStatus(
      "session-goal",
      footer ? ctx.ui.theme.fg(statusColor(goal!), footer) : undefined,
    );
  };

  const notify = (
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error" = "info",
  ) => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  const assertUnlocked = () => {
    const problem = controller.problem();
    if (problem) throw new Error(`Session goal is locked: ${problem}`);
  };

  const assertModelCanCreate = () => {
    assertUnlocked();
    const current = controller.snapshot();
    if (current && isGoalUnfinished(current)) {
      throw new Error(
        "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first",
      );
    }
  };

  const createGoal = (input: GoalInput, ctx: ExtensionContext) => {
    const goal = createGoalSnapshot(
      input,
      controller.revision(),
      Date.now(),
      controller.createId(),
    );
    controller.replace(goal);
    const started = controller.kickoff(ctx);
    return { goal: controller.snapshot() ?? goal, started };
  };

  const toolResult = (
    response: ReturnType<typeof goalToolResponse>,
    message: string,
    goal?: GoalSnapshot,
  ) => ({
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    details: { goal, message } satisfies GoalToolDetails,
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description:
      "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
    promptSnippet: "Get the current goal for this thread",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute(_id, _params, _signal, _onUpdate, ctx) {
      const goal = controller.snapshot();
      const response = goalToolResponse(
        goal,
        false,
        ctx.sessionManager.getSessionId(),
      );
      return Promise.resolve(
        toolResult(response, JSON.stringify(response), goal),
      );
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("get_goal")), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderGoalTool(
        result.details as GoalToolDetails | undefined,
        options.expanded,
        theme,
        (text) =>
          theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text),
      );
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
    promptSnippet: "Create an explicitly requested persistent thread goal",
    promptGuidelines: [
      "Use create_goal only when the user or system/developer instructions explicitly request a persistent autonomous goal; never infer one from an ordinary task.",
      "Set token_budget only when an explicit token budget is requested.",
    ],
    parameters: Type.Object(
      {
        objective: Type.String({
          minLength: 1,
          maxLength: GOAL_LIMITS.objectiveChars,
          description:
            "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
        }),
        token_budget: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              "Positive token budget for the new goal. Omit unless explicitly requested.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute(_id, params, _signal, _onUpdate, ctx) {
      assertModelCanCreate();
      const { goal } = createGoal(
        { objective: params.objective, tokenBudget: params.token_budget },
        ctx,
      );
      const response = goalToolResponse(
        goal,
        false,
        ctx.sessionManager.getSessionId(),
      );
      updateUi(ctx);
      return Promise.resolve(
        toolResult(response, JSON.stringify(response), goal),
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("create_goal"))} ${theme.fg("muted", truncateGoalObjective(args.objective, 60))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      return renderGoalTool(
        result.details as GoalToolDetails | undefined,
        options.expanded,
        theme,
        (text) =>
          theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text),
      );
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Update the existing goal to mark it achieved or report a genuine blocker.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nReport status `blocked` only when a blocking condition leaves no meaningful work possible; give a specific `blocker` and reuse that exact string each following goal turn (the controller marks the goal blocked only after the same blocker recurs on three consecutive goal turns).\nDo not report `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nWhen marking a budgeted goal achieved, report the final token usage from the tool result to the user.",
    promptSnippet: "Mark an existing goal complete or strictly blocked",
    promptGuidelines: [
      "Call update_goal with complete only after a requirement-by-requirement evidence audit proves the entire objective is done.",
      "When genuinely unable to progress, report blocked once per goal turn with the same specific blocker description; the controller accepts it after three consecutive matching turns.",
    ],
    // Keep the tool schema's root an object. Some OpenAI-compatible providers
    // reject a top-level anyOf even though JSON Schema permits it.
    parameters: Type.Object(
      {
        status: StringEnum(["complete", "blocked"] as const, {
          description:
            "Required. Set to `complete` only when the objective is achieved. Report `blocked` only for a genuine current impasse; the controller enforces the three-turn audit.",
        }),
        blocker: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: GOAL_LIMITS.reasonChars,
            description:
              "Required when status is `blocked`; omit for `complete`. Reuse exactly the same specific description on each consecutive goal turn while the blocker persists.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.status === "complete" && params.blocker !== undefined) {
        throw new Error("Complete goal updates must not include a blocker.");
      }
      const update = controller.updateFromModel(params.status, params.blocker);
      const response = {
        ...goalToolResponse(
          update.goal,
          params.status === "complete",
          ctx.sessionManager.getSessionId(),
        ),
        blockedAudit: update.blockedAudit ?? null,
        message: update.message,
      };
      updateUi(ctx);
      return Promise.resolve(
        toolResult(response, JSON.stringify(response), update.goal),
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("update_goal"))} ${theme.fg("muted", sanitizeTerminalText(args.status))}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      return renderGoalTool(
        result.details as GoalToolDetails | undefined,
        options.expanded,
        theme,
        (text) =>
          theme.bg(context.isError ? "toolErrorBg" : "toolSuccessBg", text),
      );
    },
  });

  pi.registerCommand("goal", {
    description: "Usage: /goal [<objective>|clear|edit|pause|resume]",
    handler: async (args, ctx) => {
      const parsed = parseGoalCommand(args);
      try {
        if (parsed.action === "status") {
          notify(ctx, statusText(controller.snapshot(), controller.problem()));
        } else if (parsed.action === "pause") {
          const goal = controller.pause();
          notify(ctx, goalUpdateMessage(goal!));
        } else if (parsed.action === "resume") {
          if (ctx.mode === "print" || ctx.mode === "json") {
            throw new Error(`Goal automation is disabled in ${ctx.mode} mode.`);
          }
          controller.resume();
          controller.kickoff(ctx);
          // Report the status AFTER kickoff: dispatching the first turn can
          // change it (e.g. a dispatch failure pauses the goal), so notifying
          // with the pre-kickoff snapshot would show a status the footer then
          // contradicts.
          notify(ctx, goalUpdateMessage(controller.snapshot()!));
        } else if (parsed.action === "clear") {
          notify(
            ctx,
            controller.clear()
              ? "Goal cleared"
              : "No goal to clear\nThis thread does not currently have a goal.",
          );
        } else if (parsed.action === "edit") {
          const current = controller.snapshot();
          if (!current) {
            throw new Error(
              `No goal is currently set.\n${GOAL_USAGE}\nCreate a goal before editing it.`,
            );
          }
          if (!ctx.hasUI)
            throw new Error("Goal editing requires an interactive UI.");
          const objective = await ctx.ui.editor("Edit goal", current.objective);
          if (objective === undefined) return;
          const goal = controller.edit(objective, ctx);
          notify(ctx, goalUpdateMessage(goal!));
        } else {
          const current = controller.snapshot();
          if (current && isGoalUnfinished(current)) {
            if (!ctx.hasUI) {
              throw new Error(
                "An unfinished goal already exists and replacement requires confirmation.",
              );
            }
            const choice = await ctx.ui.select("Replace goal?", [
              "Replace current goal",
              "Cancel",
            ]);
            if (choice !== "Replace current goal") return;
            controller.clear();
          }
          if (!parsed.objective) return;
          const { goal } = createGoal({ objective: parsed.objective }, ctx);
          notify(ctx, goalUpdateMessage(goal));
        }
      } catch (error) {
        notify(
          ctx,
          error instanceof Error ? error.message : String(error),
          "warning",
        );
      } finally {
        updateUi(ctx);
      }
    },
  });

  pi.registerMessageRenderer(
    GOAL_CONTINUATION_TYPE,
    (message, _options, theme) =>
      new Text(
        theme.fg("accent", goalContinuationLabel(message.details)),
        0,
        0,
      ),
  );

  pi.on("session_start", async (event, ctx) => {
    controller.restore(ctx, event.reason === "fork");
    if (controller.problem()) {
      notify(
        ctx,
        `Session goal locked: ${controller.problem()}. Navigate to a clean branch or start a new session.`,
        "warning",
      );
      updateUi(ctx);
      return;
    }
    const goal = controller.snapshot();
    if (goal?.status === "active" && !goal.deferContinuation) {
      controller.kickoff(ctx);
    } else if (
      goal &&
      canResumeGoal(goal) &&
      ctx.mode === "tui" &&
      event.reason !== "fork"
    ) {
      const shouldResume = await ctx.ui.confirm(
        "Resume paused goal?",
        `Goal: ${sanitizeTerminalText(goal.objective)}\n\nMark it active and continue when idle?`,
      );
      if (shouldResume) {
        controller.resume();
        controller.kickoff(ctx);
      }
    }
    updateUi(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    controller.restore(ctx, true);
    updateUi(ctx);
  });

  pi.on("input", (event) => {
    if (event.source === "extension") {
      const sanitized = controller.sanitizeCompletionMarkerImages(event.images);
      return sanitized.changed
        ? {
            action: "transform" as const,
            text: event.text,
            images: sanitized.images,
          }
        : { action: "continue" as const };
    }
    const sanitized = controller.sanitizeCompletionMarkerImages(event.images);
    const marker = controller.prepareExplicitInput();
    return marker === undefined && !sanitized.changed
      ? { action: "continue" as const }
      : {
          action: "transform" as const,
          text: event.text,
          images:
            marker === undefined
              ? sanitized.images
              : [...sanitized.images, marker],
        };
  });

  pi.on("agent_start", (_event, ctx) => {
    controller.agentStarted();
    updateUi(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const result = controller.messageEnded(event.message);
    if (!result) return;
    if (result.footerChanged) updateUi(ctx);
    return { message: result.message as typeof event.message };
  });

  pi.on("turn_end", () => {
    controller.turnEnded();
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    controller.toolFinished(ctx);
    updateUi(ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    controller.agentEnded(event.messages);
    updateUi(ctx);
  });

  pi.on("session_compact", (event) => {
    controller.compacted(event.willRetry);
  });

  pi.on("agent_settled", (_event, ctx) => {
    controller.settled(ctx);
    controller.settledWithoutAcknowledgement();
    updateUi(ctx);
    notifyBlockedGoal(ctx);
  });

  // A blocked goal needs a human in the loop (owner ruling, external wait);
  // the footer says so but nothing raises an event. Announce it once per
  // blocked stint, re-armed when the goal leaves the blocked state.
  let notifiedGoalBlocked = false;
  const notifyBlockedGoal = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const goal = controller.snapshot();
    if (goal?.status === "blocked") {
      if (notifiedGoalBlocked) return;
      notifiedGoalBlocked = true;
      ctx.ui.notify(
        `Goal blocked: ${goal.objective} — 需要人工介入 (/goal resume)`,
        "warning",
      );
    } else {
      notifiedGoalBlocked = false;
    }
  };

  pi.on("session_shutdown", (_event, ctx) => {
    controller.shutdown();
    if (ctx.hasUI) ctx.ui.setStatus("session-goal", undefined);
  });
}

function publicGoal(goal: GoalSnapshot, threadId?: string) {
  return {
    ...(threadId === undefined ? {} : { threadId }),
    objective: goal.objective,
    status: goal.status,
    ...(goal.tokenBudget === undefined
      ? {}
      : { tokenBudget: goal.tokenBudget }),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: Math.floor(goal.createdAt / 1_000),
    updatedAt: Math.floor(goal.updatedAt / 1_000),
  };
}

function goalUpdateMessage(goal: GoalSnapshot) {
  const parts = [
    `Goal ${sanitizeTerminalText(statusLabel(goal.status))}`,
    `Objective: ${sanitizeTerminalText(goal.objective)}`,
  ];
  if (goal.timeUsedSeconds > 0) {
    parts.push(`Time: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}.`);
  }
  if (goal.tokenBudget !== undefined) {
    parts.push(
      `Tokens: ${formatTokensCompact(goal.tokensUsed)}/${formatTokensCompact(goal.tokenBudget)}.`,
    );
  }
  return parts.join("\n");
}
