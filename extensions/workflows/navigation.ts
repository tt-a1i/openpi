import type { TUI } from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
  belowEditorStripInput,
  fitNavigationSides,
  renderNavigationMetrics,
} from "../shared/below-editor-navigation.ts";
import { spinnerFrame } from "../shared/spinner.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  aggregateUsage,
  countStates,
  formatElapsed,
  formatTokens,
  statusColor,
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

/**
 * One status indicator per run state; doubles as the focus marker when
 * selected. Running spins, in step with the dashboard and takeover headers.
 */
function statusGlyph(status: WorkflowStatus, theme: Theme, now: number) {
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "running") return theme.fg("warning", spinnerFrame(now));
  return theme.fg("error", "✗");
}

/** Live, one-line Claude-style workflow entry rendered below the editor. */
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
    const entry = this.getEntry();
    if (!entry || width <= 0) return [];
    const details = entry.details;
    const { done, failed } = countStates(details);
    const settled = done + failed;
    const usage = aggregateUsage(details.agents);
    const tokenCount = usage.input + usage.output;
    const glyph = this.strip.focused
      ? this.theme.fg("accent", "❯")
      : statusGlyph(details.status, this.theme, Date.now());
    const displayName = cleanLine(details.name ?? entry.runId) || entry.runId;
    const name = this.strip.focused
      ? this.theme.bold(this.theme.fg("accent", displayName))
      : this.theme.fg("text", displayName);
    const rawContext = details.currentPhase ?? details.description;
    const context = rawContext ? cleanLine(rawContext) : undefined;
    const left = ` ${glyph} ${name}${context ? this.theme.fg("dim", ` · ${context}`) : ""}`;
    const right = renderNavigationMetrics(
      this.theme,
      [
        details.agents.length > 0
          ? `${settled}/${details.agents.length} agents`
          : undefined,
        formatElapsed(details.startedAt, details.finishedAt),
        tokenCount > 0 ? `${formatTokens(tokenCount)} tokens` : undefined,
      ],
      this.strip.focused ? "enter open · ↑ back" : "↓ to manage",
      details.status === "running" ? undefined : statusColor(details.status),
    );
    return [fitNavigationSides(left, right, width)];
  }
}
