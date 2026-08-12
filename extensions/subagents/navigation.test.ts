import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { BelowEditorStripState } from "../shared/below-editor-navigation.ts";
import {
  normalizeSubagentTitle,
  selectSubagentStripEntry,
  SubagentStripWidget,
} from "./navigation.ts";
import type { SubagentSnapshot } from "./src/domain.ts";

function snapshot(
  id: string,
  status: SubagentSnapshot["status"],
  createdAt: number,
  settledAt?: number,
): SubagentSnapshot {
  return {
    id,
    origin: "model",
    backend: "pi",
    title: `${id}\u001b]52;c;payload\u0007`,
    prompt: "inspect",
    cwd: "/repo",
    status,
    createdAt,
    ...(settledAt === undefined ? {} : { settledAt }),
    meta: { backend: "pi", modelLabel: "openai-codex/gpt-5.6-sol" },
    usage: { tokens: 1_000, contextWindow: 10_000 },
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("subagent titles are sanitized and bounded at ingress", () => {
  assert.equal(
    normalizeSubagentTitle(" review\u001b]52;c;payload\u0007\nnow "),
    "review now",
  );
  assert.equal(normalizeSubagentTitle("\u001b[31m\u001b[0m"), "subagent");
  assert.equal(normalizeSubagentTitle("x".repeat(200)).length, 160);
});

test("strip selection prefers newest running, then newest unread settled", () => {
  const entries = [
    snapshot("done", "done", 1, 5),
    snapshot("running-old", "running", 2),
    snapshot("running-new", "running", 3),
  ];
  assert.equal(
    selectSubagentStripEntry(entries, 0)?.snapshot.id,
    "running-new",
  );
  assert.equal(
    selectSubagentStripEntry(
      [snapshot("old", "done", 1, 5), snapshot("new", "error", 2, 8)],
      6,
    )?.snapshot.id,
    "new",
  );
  assert.equal(
    selectSubagentStripEntry([snapshot("old", "done", 1, 5)], 6),
    undefined,
  );
});

test("subagent HUD mirrors omp: header plus one row per running subagent", () => {
  const strip = new BelowEditorStripState();
  const entries = [
    snapshot("sa-1", "running", Date.now() - 2_000),
    snapshot("sa-2", "running", Date.now() - 1_000),
    snapshot("sa-0", "done", 0, 500),
  ];
  const entry = selectSubagentStripEntry(entries, 0);
  const widget = new SubagentStripWidget(
    { requestRender() {} } as unknown as TUI,
    theme,
    strip,
    () => entry,
    () => entries,
  );
  try {
    const idle = widget.render(100);
    // Header + one row per running subagent + unread-settled notice row.
    assert.equal(idle.length, 4);
    assert.match(idle[0]!, /Subagents/);
    assert.match(idle[0]!, /2 running/);
    assert.match(idle[0]!, /1 done/);
    assert.doesNotMatch(idle[0]!, /finished/);
    assert.match(idle[0]!, /↓ to manage/);
    assert.doesNotMatch(idle.join("\n"), /payload/);
    assert.match(idle[1]!, /sa-1/);
    assert.match(idle[2]!, /sa-2/);
    assert.match(idle[3]!, /1 finished — enter to review/);
    // The settled subagent itself is not a running row.
    assert.doesNotMatch(idle.join("\n"), /sa-0/);

    strip.focused = true;
    const focused = widget.render(100);
    assert.equal(focused.length, 4);
    assert.match(focused[0]!, /enter open/);

    for (const width of [1, 8, 20, 54]) {
      const narrow = widget.render(width);
      assert.equal(narrow.length, 4);
      for (const line of narrow) assert.ok(visibleWidth(line) <= width);
    }
  } finally {
    widget.dispose();
  }
});

test("subagent HUD collapses running rows past its limit", () => {
  const strip = new BelowEditorStripState();
  const now = Date.now();
  const entries = Array.from({ length: 6 }, (_, index) =>
    snapshot(`sa-${index + 1}`, "running", now - (6 - index)),
  );
  const widget = new SubagentStripWidget(
    { requestRender() {} } as unknown as TUI,
    theme,
    strip,
    () => selectSubagentStripEntry(entries, 0),
    () => entries,
  );
  try {
    const lines = widget.render(100);
    // 1 header + 4 rows + 1 hidden-count row (no settled entries).
    assert.equal(lines.length, 6);
    assert.match(lines[0]!, /6 running/);
    assert.match(lines[5]!, /… 2 more running/);
  } finally {
    widget.dispose();
  }
});

test("subagent HUD shows the newest unfinished tool per running row", () => {
  const strip = new BelowEditorStripState();
  const busy = {
    ...snapshot("sa-1", "running", Date.now() - 2_000),
    liveTools: [
      {
        toolId: "a",
        name: "read",
        argsPreview: "src/a.ts",
        done: true,
      },
      {
        toolId: "b",
        name: "bash",
        argsPreview: "npm test",
      },
    ],
  };
  const widget = new SubagentStripWidget(
    { requestRender() {} } as unknown as TUI,
    theme,
    strip,
    () => ({ snapshot: busy, counts: { running: 1, done: 0, failed: 0 } }),
    () => [busy],
  );
  try {
    const lines = widget.render(120);
    assert.equal(lines.length, 2);
    // Newest unfinished tool (bash), not the finished read.
    assert.match(lines[1]!, /⚙ bash/);
    assert.match(lines[1]!, /npm test/);
    assert.doesNotMatch(lines[1]!, /read/);
  } finally {
    widget.dispose();
  }
});

test("subagent HUD hides itself when nothing is running or unread", () => {
  const strip = new BelowEditorStripState();
  const widget = new SubagentStripWidget(
    { requestRender() {} } as unknown as TUI,
    theme,
    strip,
    () => selectSubagentStripEntry([snapshot("old", "done", 1, 5)], 6),
    () => [snapshot("old", "done", 1, 5)],
  );
  try {
    assert.deepEqual(widget.render(100), []);
  } finally {
    widget.dispose();
  }
});
