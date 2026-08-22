import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

export interface ActivityCounts {
  running: number;
  done: number;
  failed: number;
}

/**
 * Settled work is an unread notice, not a session tally: `done`/`failed` stay
 * visible until the user's next explicit request acknowledges them, while
 * running work is always reported. `acknowledgedAt` is the timestamp of that
 * last explicit request. A settle in that same millisecond, or one carrying no
 * timestamp, stays unread rather than being silently swallowed.
 */
export function unreadActivityCounts(
  items: readonly {
    readonly status: "running" | "done" | "error";
    readonly settledAt?: number;
  }[],
  acknowledgedAt: number,
): ActivityCounts {
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const item of items) {
    if (item.status === "running") {
      running += 1;
      continue;
    }
    if (item.settledAt !== undefined && item.settledAt < acknowledgedAt)
      continue;
    if (item.status === "error") failed += 1;
    else done += 1;
  }
  return { running, done, failed };
}

export function hasActivity(counts: ActivityCounts) {
  return counts.running + counts.done + counts.failed > 0;
}

export function formatActivityStatus(
  theme: Theme,
  label: "subagents" | "workflows",
  counts: ActivityCounts,
) {
  // No status glyphs here: the footer line is a static string refreshed on
  // events, so a spinner would freeze between updates — the colored words
  // carry the state on their own.
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(theme.fg("warning", `${counts.running} running`));
  }
  if (counts.done > 0) {
    parts.push(theme.fg("success", `${counts.done} done`));
  }
  if (counts.failed > 0) {
    parts.push(theme.fg("error", `${counts.failed} failed`));
  }
  parts.push(theme.fg("accent", `/${label}`) + theme.fg("dim", " to view"));

  return `${theme.fg("muted", `${label}:`)} ${parts.join(theme.fg("dim", " · "))}`;
}
