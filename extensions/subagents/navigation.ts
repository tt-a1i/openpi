import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
  fitNavigationSides,
  type BelowEditorStripState,
} from "../shared/below-editor-navigation.ts";
import {
  unreadActivityCounts,
  type ActivityCounts,
} from "../shared/activity-status.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { formatElapsed, type SubagentSnapshot } from "./src/domain.ts";
import {
  failureStreakOf,
  isStalled,
  lastActivityOf,
  lastIntentOf,
} from "./src/domain.ts";
import { formatContextUtilization } from "./src/format.ts";

export interface SubagentStripEntry {
  snapshot: SubagentSnapshot;
  counts: ActivityCounts;
}

function cleanLine(value: string) {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

/** Normalize every title before it enters snapshots, artifacts, or the TUI. */
export function normalizeSubagentTitle(value: string, fallback = "subagent") {
  return cleanLine(value).slice(0, 160) || fallback;
}

/** Prefer the newest running child, then the newest unread settled child. */
export function selectSubagentStripEntry(
  snapshots: readonly SubagentSnapshot[],
  acknowledgedAt: number,
): SubagentStripEntry | undefined {
  const counts = unreadActivityCounts(snapshots, acknowledgedAt);
  const visible = snapshots.filter(
    (snapshot) =>
      snapshot.status === "running" ||
      snapshot.settledAt === undefined ||
      snapshot.settledAt >= acknowledgedAt,
  );
  const candidates = visible.some((snapshot) => snapshot.status === "running")
    ? visible.filter((snapshot) => snapshot.status === "running")
    : visible;
  let selected: SubagentSnapshot | undefined;
  for (const snapshot of candidates) {
    const timestamp = snapshot.settledAt ?? snapshot.createdAt;
    const selectedTimestamp = selected
      ? (selected.settledAt ?? selected.createdAt)
      : -Infinity;
    if (timestamp >= selectedTimestamp) selected = snapshot;
  }
  return selected ? { snapshot: selected, counts } : undefined;
}

function statusColor(status: SubagentSnapshot["status"]) {
  if (status === "running") return "warning" as const;
  if (status === "done") return "success" as const;
  return "error" as const;
}

function statusSquare(snapshot: SubagentSnapshot, theme: Theme) {
  return theme.fg(statusColor(snapshot.status), "■");
}

/**
 * Running-subagent rows the HUD can show before collapsing the rest.
 * Matches the tasks widget's limit so the two blocks above the editor never
 * crowd the prompt out of view on a short terminal.
 */
export const SUBAGENT_HUD_ROWS = 4;

/**
 * Anchored multi-row subagent HUD above the editor, mirroring omp's sticky
 * "Subagents" block: one header line with live metrics, then a bounded row per
 * running subagent, then a single notice row for unread settled results. The
 * whole block is one contiguous widget, so tool rows in the transcript can
 * never tear it apart.
 */
export class SubagentStripWidget {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly strip: BelowEditorStripState;
  private readonly getEntry: () => SubagentStripEntry | undefined;
  private readonly getEntries: () => readonly SubagentSnapshot[];

  constructor(
    tui: TUI,
    theme: Theme,
    strip: BelowEditorStripState,
    getEntry: () => SubagentStripEntry | undefined,
    getEntries: () => readonly SubagentSnapshot[],
  ) {
    this.tui = tui;
    this.theme = theme;
    this.strip = strip;
    this.getEntry = getEntry;
    this.getEntries = getEntries;
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
    // Nothing running and nothing unread: the HUD has nothing to say and hides
    // itself entirely instead of parking an empty header above the prompt.
    if (!entry) return [];
    const { snapshot, counts } = entry;
    const running = this.getEntries().filter(
      (item) => item.status === "running",
    );
    const lines: string[] = [];

    const marker = this.strip.focused
      ? this.theme.fg("accent", "❯")
      : this.theme.fg("dim", "○");
    const settled = counts.done + counts.failed;
    const metrics = [
      running.length > 0 ? `${running.length} running` : undefined,
      counts.done > 0 ? `${counts.done} done` : undefined,
      counts.failed > 0 ? `${counts.failed} failed` : undefined,
      formatElapsed(snapshot),
      formatContextUtilization(snapshot.usage),
      this.strip.focused ? "enter open · ↑ back" : "↓ to manage",
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    const header = fitNavigationSides(
      ` ${marker} ${this.theme.fg("text", this.theme.bold("Subagents"))}`,
      this.theme.fg(statusColor(snapshot.status), metrics),
      width,
    );
    lines.push(header);

    // One row per running subagent, same `■ title · model` shape the single
    // strip used; the selected entry reads at full weight so the manager's
    // default target is obvious without the row list turning noisy. When the
    // subagent is mid-tool, its newest unfinished tool shows inline (omp's
    // `currentTool · args`): the row moves when work moves, so a long-running
    // child reads as busy instead of frozen.
    const visible = running.slice(0, SUBAGENT_HUD_ROWS);
    const hidden = running.length - visible.length;
    for (const item of visible) {
      const titleText = normalizeSubagentTitle(item.title, item.id);
      const title =
        item.id === snapshot.id
          ? this.strip.focused
            ? this.theme.bold(this.theme.fg("accent", titleText))
            : this.theme.fg("accent", titleText)
          : this.theme.fg("text", titleText);
      const model = item.meta.modelLabel
        ? cleanLine(item.meta.modelLabel)
        : undefined;
      const latestTool = [...item.liveTools]
        .reverse()
        .find((tool) => tool.done !== true);
      // Visibility triad: live tool → intent fallback → stall warning. A
      // running row must never render as a bare title with no sign of life.
      const action = latestTool
        ? ` ${this.theme.fg("dim", "⚙")} ${this.theme.fg("muted", `${latestTool.name}${latestTool.argsPreview ? ` ${cleanLine(latestTool.argsPreview)}` : ""}`)}`
        : lastIntentOf(item)
          ? ` ${this.theme.fg("dim", "💬")} ${this.theme.fg("muted", cleanLine(lastIntentOf(item)!))}`
          : isStalled(item, Date.now())
            ? ` ${this.theme.fg("error", `⚠ 无活动 ${Math.max(1, Math.round((Date.now() - lastActivityOf(item)) / 60_000))}m`)}`
            : "";
      const failures = failureStreakOf(item);
      const failureMark =
        failures >= 2
          ? ` ${this.theme.fg("warning", `✗ 连败 ${failures}`)}`
          : "";
      lines.push(
        truncateToWidth(
          `  ${statusSquare(item, this.theme)} ${title}${model ? this.theme.fg("dim", ` · ${model}`) : ""}${action}${failureMark}`,
          width,
        ),
      );
    }
    if (hidden > 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", `  … ${hidden} more running`),
          width,
        ),
      );
    }
    if (settled > 0) {
      lines.push(
        truncateToWidth(
          `${this.theme.fg("dim", "  ○")} ${this.theme.fg("dim", `${settled} finished — enter to review`)}`,
          width,
        ),
      );
    }
    return lines;
  }
}
