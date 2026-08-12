import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
  belowEditorStripInput,
  fitNavigationSides,
} from "../shared/below-editor-navigation.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  aggregateUsage,
  countStates,
  formatElapsed,
  formatTokens,
  statusColor,
  statusSquare,
  type Theme,
  type WorkflowDetails,
  type WorkflowStatus,
} from "./model.ts";

/** Workflow-named aliases preserve the public seam while sharing interaction. */
export {
  BelowEditorNavigationEditor as WorkflowNavigationEditor,
  BelowEditorStripState as WorkflowStripState,
  belowEditorStripInput as workflowStripInput,
};

export interface WorkflowStripEntry {
  runId: string;
  details: WorkflowDetails;
}

function cleanLine(value: string) {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

/** Live, multi-row workflow HUD above the editor, mirroring the Subagents HUD. */
export class WorkflowStripWidget {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly strip: BelowEditorStripState;
  private readonly getEntry: () => WorkflowStripEntry | undefined;

  constructor(
    tui: TUI,
    theme: Theme,
    strip: BelowEditorStripState,
    getEntry: () => WorkflowStripEntry | undefined,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.strip = strip;
    this.getEntry = getEntry;
    this.timer = setInterval(() => this.tui.requestRender(), 500);
    this.timer.unref?.();
  }

  dispose() {
    clearInterval(this.timer);
  }

  invalidate() {}

  render(width: number) {
    if (width <= 0) return [];
    const entry = this.getEntry();
    if (!entry) return [];
    const details = entry.details;
    const { done, failed, running } = countStates(details);
    const settled = done + failed;
    const usage = aggregateUsage(details.agents);
    const tokenCount = usage.input + usage.output;
    const lines: string[] = [];

    // Header, same shape as the Subagents HUD — but its right-side metrics
    // render in accent rather than warning, so the two stacked panels never
    // blur into one another at a glance.
    const marker = this.strip.focused
      ? this.theme.fg("accent", "❯")
      : this.theme.fg("dim", "○");
    const displayName = cleanLine(details.name ?? entry.runId) || entry.runId;
    const name = this.strip.focused
      ? this.theme.bold(this.theme.fg("accent", displayName))
      : this.theme.fg("text", displayName);
    const left = ` ${marker} ${statusSquare(details.status, this.theme)} ${this.theme.fg("text", this.theme.bold("Workflow"))} · ${name}`;
    const metrics = [
      running > 0 ? `${running} running` : undefined,
      settled > 0 ? `${settled} done` : undefined,
      failed > 0 ? `${failed} failed` : undefined,
      formatElapsed(details.startedAt, details.finishedAt),
      tokenCount > 0 ? `${formatTokens(tokenCount)} tokens` : undefined,
      this.strip.focused ? "enter open · ↑ back" : "↓ to manage",
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    lines.push(
      fitNavigationSides(left, this.theme.fg("accent", metrics), width),
    );

    // One row per agent, same `■ label · phase` shape as the Subagents rows.
    const visible = details.agents.slice(0, WORKFLOW_HUD_ROWS);
    const hidden = details.agents.length - visible.length;
    for (const agent of visible) {
      const phase = agent.phase ? ` · ${cleanLine(agent.phase)}` : "";
      const model = agent.model ? ` · ${cleanLine(agent.model)}` : "";
      // AgentState (running/done/error) maps onto WorkflowStatus (running/
      // completed/failed/aborted) for the status square.
      const state: WorkflowStatus =
        agent.state === "done"
          ? "completed"
          : agent.state === "error"
            ? "failed"
            : "running";
      lines.push(
        truncateToWidth(
          `  ${statusSquare(state, this.theme)} ${this.theme.fg("text", cleanLine(agent.label))}${phase}${model}`,
          width,
        ),
      );
    }
    if (hidden > 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", `  … ${hidden} more agents`),
          width,
        ),
      );
    }
    if (details.status === "failed" || details.status === "aborted") {
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "error",
            `  ✗ ${details.status === "failed" ? "failed" : "aborted"} — enter to inspect`,
          ),
          width,
        ),
      );
    }
    return lines;
  }
}

/** Running-agent rows the workflow HUD shows before collapsing the rest. */
export const WORKFLOW_HUD_ROWS = 4;
