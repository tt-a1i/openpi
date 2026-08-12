import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { TaskItem, TaskSnapshot } from "./tasks.ts";
import { getTaskWidgetAttachment } from "../shared/task-widget-attachment.ts";

const STATUS_ICON: Record<TaskItem["status"], string> = {
  pending: "○",
  in_progress: "●",
  blocked: "!",
  done: "✓",
  dropped: "×",
};

/**
 * Time-driven busy glyph for the widget's in-progress row, mirroring omp's
 * spinner cadence: the row visibly moves while work is in flight, so a long
 * agent turn cannot read as a frozen task panel. Static views (tool results,
 * the /tasks screen) keep the plain `●`, because they are settled snapshots.
 */
export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
export const SPINNER_FRAME_MS = 160;

export function spinnerFrame(now: number) {
  return Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
}

/**
 * Sweep a brightness band across a text run, omp-style shimmer: every
 * character outside the band is dim, inside it steps up to muted and then
 * accent+bold at the crest. The band advances at a fixed cell velocity, so at
 * the widget's redraw cadence it moves about one cell per frame — the row
 * visibly *flows* from across the room, unlike a small spinning glyph that
 * only reads up close.
 */
export function shimmerText(
  text: string,
  theme: Theme,
  now: number,
  options: { speedCellsPerS?: number; bandHalfWidth?: number } = {},
): string {
  const speed = options.speedCellsPerS ?? 8;
  const bandHalf = options.bandHalfWidth ?? 5;
  const width = [...text].length;
  if (width === 0) return text;
  const period = width + bandHalf * 2;
  const crest = (((now / 1000) * speed) % period) - bandHalf;
  let out = "";
  let index = 0;
  for (const ch of text) {
    const dist = Math.abs(index - crest);
    out +=
      dist <= 1
        ? theme.bold(theme.fg("accent", ch))
        : dist <= bandHalf
          ? theme.fg("muted", ch)
          : theme.fg("dim", ch);
    index++;
  }
  return out;
}

const TASK_WIDGET_ORDER: Record<TaskItem["status"], number> = {
  in_progress: 0,
  blocked: 1,
  pending: 2,
  done: 3,
  dropped: 4,
};

export const TASK_WIDGET_LIMIT = 4;

/**
 * A settled item's subject reads as struck-through and dimmed, so a glance at
 * the list separates what is left from what is behind you.
 *
 * Both, not either: SGR 9 is widely but not universally supported, and a
 * terminal that drops it would otherwise render done items identically to
 * open ones. The dim color survives on its own.
 */
function subjectStyle(status: TaskItem["status"], theme: Theme) {
  if (status === "done" || status === "dropped") {
    return (text: string) => theme.strikethrough(theme.fg("dim", text));
  }
  // The one item being worked on is the only thing most glances are looking
  // for, so it is the only one rendered at full weight.
  if (status === "in_progress") {
    return (text: string) => theme.bold(theme.fg("text", text));
  }
  return (text: string) =>
    theme.fg(status === "blocked" ? "text" : "muted", text);
}

const SUMMARY_LABEL: Record<TaskItem["status"], string> = {
  done: "done",
  in_progress: "in progress",
  blocked: "blocked",
  pending: "open",
  dropped: "dropped",
};

/** Order the counts by how far along they are, not by status enum order. */
const SUMMARY_ORDER: TaskItem["status"][] = [
  "done",
  "in_progress",
  "blocked",
  "pending",
  "dropped",
];

/** Census of a whole batch, independent of which rows a view chooses to show. */
export type TaskCounts = Record<TaskItem["status"], number> & { total: number };

export function taskCounts(items: readonly TaskItem[]): TaskCounts {
  const counts: TaskCounts = {
    total: items.length,
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    dropped: 0,
  };
  for (const item of items) counts[item.status]++;
  return counts;
}

/**
 * One-line census: `4 tasks (3 done, 1 in progress, 0 open)`.
 *
 * Counts carry the weight and the words recede, so the shape of the batch
 * reads before any individual row does. `done`, `in progress`, and `open` are
 * always listed even at zero — a stable set of three keeps the line from
 * reflowing as work moves between them. `blocked` and `dropped` are
 * exceptional and appear only when they are not zero.
 *
 * Takes counts rather than items because a view often shows a bounded subset
 * of rows; the header must describe the whole batch regardless.
 */
export function renderTaskSummary(counts: TaskCounts, theme: Theme): string {
  const number = (value: number) => theme.bold(theme.fg("text", String(value)));
  const dim = (text: string) => theme.fg("dim", text);
  // Coerced, not trusted: these counts can arrive from a tool-result record
  // persisted by an older build, where a missing key would render the literal
  // word "undefined" (or "NaN tasks") into the header.
  const count = (status: TaskItem["status"]) =>
    Number.isFinite(counts[status]) ? counts[status] : 0;
  const total = Number.isFinite(counts.total) ? counts.total : 0;
  // Built segment by segment rather than by wrapping the whole line: each
  // styled run emits its own reset, so an outer color would stop applying at
  // the first inner one.
  const parts = SUMMARY_ORDER.filter(
    (status) =>
      status === "done" ||
      status === "in_progress" ||
      status === "pending" ||
      count(status) > 0,
  ).map((status) => `${number(count(status))} ${dim(SUMMARY_LABEL[status])}`);
  return [
    number(total),
    " ",
    dim(total === 1 ? "task" : "tasks"),
    " ",
    dim("("),
    parts.join(dim(", ")),
    dim(")"),
  ].join("");
}

export interface TaskToolDetails {
  action: "add" | "update" | "list";
  items: TaskItem[];
  total: number;
  revision: number;
  batchClosed?: boolean;
  /** Census of the whole batch; `items` is only the rows this call touched. */
  counts?: TaskCounts;
}

export function renderTaskRows(
  items: readonly TaskItem[],
  theme: Theme,
  width: number,
) {
  if (items.length === 0) return [theme.fg("dim", "No task items.")];
  // Ids address tasks in tasks_update, so they stay — but right-aligned, so a
  // T10 appearing later never shifts every subject one column over.
  // Floor of 3 ("T99"), not 2: the width is computed per view, so a batch
  // crossing T9 — or the same batch shown collapsed (5 rows) then expanded
  // (all of them) — would otherwise shift every subject sideways by a column.
  const idWidth = Math.max(...items.map((item) => `T${item.id}`.length), 3);
  return items.flatMap((item) => {
    const color =
      item.status === "done"
        ? "success"
        : item.status === "blocked"
          ? "warning"
          : item.status === "dropped"
            ? "error"
            : item.status === "in_progress"
              ? "accent"
              : "muted";
    // No `[status]` text: the icon, its color, and the subject's own weight
    // already say it, and repeating it in words crowded every row.
    const id = `T${item.id}`.padStart(idWidth);
    const rows = [
      truncateToWidth(
        `${theme.fg(color, STATUS_ICON[item.status])} ${theme.fg("dim", id)} ${subjectStyle(item.status, theme)(item.subject)}`,
        width,
      ),
    ];
    // Continuation lines hang under the subject, not the icon, so the eye
    // follows one left edge down the list.
    const indent = " ".repeat(idWidth + 3);
    if (item.detail) {
      rows.push(
        truncateToWidth(`${indent}${theme.fg("dim", item.detail)}`, width),
      );
    }
    if (item.note) {
      const label =
        item.status === "blocked"
          ? "Blocked"
          : item.status === "done"
            ? "Evidence"
            : item.status === "dropped"
              ? "Reason"
              : "Note";
      rows.push(
        truncateToWidth(
          `${indent}${theme.fg("dim", `${label}:`)} ${theme.fg("muted", item.note)}`,
          width,
        ),
      );
    }
    return rows;
  });
}

export function renderTaskWidget(
  snapshot: TaskSnapshot,
  theme: Theme,
  width: number,
  expanded = false,
  now = Date.now(),
) {
  const tracked = snapshot.items.filter((item) => item.status !== "dropped");
  const actionable = tracked
    .filter((item) => item.status !== "done")
    .sort(
      (left, right) =>
        TASK_WIDGET_ORDER[left.status] - TASK_WIDGET_ORDER[right.status] ||
        left.id - right.id,
    );
  if (actionable.length === 0) return [];

  // Completed items stay visible, struck through and dimmed, mirroring omp's
  // todo HUD: the glance that finds what is left also sees what is behind.
  // Dropped items stay hidden — they are deliberate discard, not history.
  const done = tracked
    .filter((item) => item.status === "done")
    .sort((left, right) => left.id - right.id);
  const all = [...actionable, ...done];

  const hasOverflow = all.length > TASK_WIDGET_LIMIT;
  const toggleHint = hasOverflow
    ? `  ·  ctrl+shift+t ${expanded ? "collapse" : "show all"}`
    : "";
  // Same census as the full list and the /tasks screen. Counted over `tracked`
  // rather than every item, because the widget deliberately hides dropped work
  // and a total that included it would not add up against the rows shown.
  const header =
    theme.fg("accent", "◆ ") +
    theme.fg("text", theme.bold("Tasks")) +
    "  " +
    renderTaskSummary(taskCounts(tracked), theme) +
    theme.fg("dim", `  ·  /tasks${toggleHint}`);
  const visible = expanded ? all : all.slice(0, TASK_WIDGET_LIMIT);
  const hidden = all.length - visible.length;
  // Right-aligned like the full list, with the same floor: a widget whose ids
  // are ragged next to a list whose ids are not reads as a different control.
  const idWidth = Math.max(...visible.map((i) => `T${i.id}`.length), 3);
  const lines = [truncateToWidth(header, width)];
  // A sibling extension (multi-signal-sync) can pin a completion-signal
  // reminder here; it renders as the first row under the census so the notice
  // reads together with the list it asks the agent to sync.
  const attachment = getTaskWidgetAttachment();
  if (attachment) {
    lines.push(truncateToWidth(theme.fg("warning", `  ${attachment}`), width));
  }
  for (const [index, item] of visible.entries()) {
    const color =
      item.status === "done"
        ? "success"
        : item.status === "in_progress"
          ? "warning"
          : item.status === "blocked"
            ? "error"
            : "muted";
    const icon =
      item.status === "in_progress"
        ? SPINNER_FRAMES[spinnerFrame(now)]
        : STATUS_ICON[item.status];
    // The in-flight row's subject carries the shimmer sweep instead of the
    // static full-weight bold: the whole row flows, so "still running" reads
    // at a glance from across the room.
    const subject =
      item.status === "in_progress"
        ? shimmerText(item.subject, theme, now)
        : subjectStyle(item.status, theme)(item.subject);
    const branch = index === visible.length - 1 && hidden === 0 ? "╰─" : "├─";
    lines.push(
      truncateToWidth(
        // Same subject weighting as the full list, so the item in flight reads
        // the same wherever you happen to be looking; done subjects carry the
        // same strikethrough as the tool result and the /tasks screen.
        `${theme.fg("dim", branch)} ${theme.fg(color, icon)} ${theme.fg("dim", `T${item.id}`.padStart(idWidth))} ${subject}`,
        width,
      ),
    );
  }
  if (hidden > 0) {
    lines.push(
      truncateToWidth(theme.fg("dim", `╰─ … ${hidden} more tasks`), width),
    );
  }
  return lines;
}

/**
 * Rows are built at the width they will be shown at, not at a fixed width and
 * then re-wrapped. `Text` re-wraps with a wrapper that closes a line's colour
 * and underline but NOT strikethrough, so a row laid out for a wider terminal
 * and folded here left SGR 9 open across the fold — the padding to the right
 * of the break rendered as a solid struck-through bar. `truncateToWidth`
 * emits a full reset, so cutting at the real width is safe.
 */
class TaskResultView implements Component {
  private readonly details: TaskToolDetails;
  private readonly expanded: boolean;
  private readonly theme: Theme;

  constructor(details: TaskToolDetails, expanded: boolean, theme: Theme) {
    this.details = details;
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const details = this.details;
    const items = this.expanded ? details.items : details.items.slice(0, 5);
    const rows: string[] = [];
    // A closed batch has already been cleared from the live snapshot, so a
    // census here would read "0 tasks" directly above the rows it describes.
    // The "Batch complete" line below says everything that is left to say.
    if (!details.batchClosed && details.counts) {
      rows.push(renderTaskSummary(details.counts, theme));
    }
    rows.push(...renderTaskRows(items, theme, width));
    if (!this.expanded && details.items.length > items.length) {
      rows.push(
        theme.fg("dim", `… ${details.items.length - items.length} more`),
      );
    }
    if (details.batchClosed) {
      rows.push(
        theme.fg("success", "✓ Batch complete") +
          theme.fg("dim", " · next request starts at T1"),
      );
    }
    return rows.map((row) => truncateToWidth(row, width, "…"));
  }

  /** Nothing is cached between renders, so there is nothing to drop. */
  invalidate() {}
}

export function renderToolResult(
  details: unknown,
  expanded: boolean,
  theme: Theme,
  fallbackText = "Tasks updated.",
): Component {
  if (
    !details ||
    typeof details !== "object" ||
    !Array.isArray((details as Partial<TaskToolDetails>).items)
  ) {
    return new Text(theme.fg("dim", fallbackText), 0, 0);
  }
  return new TaskResultView(details as TaskToolDetails, expanded, theme);
}

class TasksScreen implements Component {
  private offset = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly snapshot: TaskSnapshot;
  private readonly done: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    snapshot: TaskSnapshot,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.snapshot = snapshot;
    this.done = done;
  }

  handleInput(data: string) {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape)
    ) {
      this.done();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "k") {
      this.offset = Math.max(0, this.offset - 1);
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "tui.editor.cursorDown") ||
      data === "j"
    ) {
      this.offset += 1;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.offset = Math.max(0, this.offset - 10);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.offset += 10;
      this.tui.requestRender();
    }
  }

  render(width: number) {
    const body = renderTaskRows(this.snapshot.items, this.theme, width - 4);
    const rows = Math.max(8, (this.tui.terminal.rows || 30) - 8);
    const maxOffset = Math.max(0, body.length - rows);
    this.offset = Math.min(this.offset, maxOffset);
    const visible = body.slice(this.offset, this.offset + rows);
    const lines = [
      truncateToWidth(
        `${this.theme.fg("accent", this.theme.bold("Session tasks"))}  ${renderTaskSummary(taskCounts(this.snapshot.items), this.theme)}`,
        width,
      ),
      this.theme.fg("border", "─".repeat(Math.max(0, width))),
      ...visible.map((line) => truncateToWidth(`  ${line}`, width)),
    ];
    while (lines.length < rows + 2) lines.push("");
    lines.push(
      truncateToWidth(
        this.theme.fg("dim", "j/k or ↑/↓ scroll · pgup/pgdn page · esc close"),
        width,
      ),
    );
    return lines;
  }

  invalidate() {}
}

export async function openTasksScreen(
  ctx: ExtensionCommandContext,
  snapshot: TaskSnapshot,
) {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(`${snapshot.items.length} task item(s)`, "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new TasksScreen(tui, theme, keybindings, snapshot, () => done()),
  );
}
