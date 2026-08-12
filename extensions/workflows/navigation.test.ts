import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  type EditorComponent,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  WorkflowNavigationEditor,
  WorkflowStripState,
  WorkflowStripWidget,
  workflowStripInput,
} from "./navigation.ts";
import type { Theme, WorkflowDetails } from "./model.ts";

test("Down focuses an available workflow only from an empty editor", () => {
  assert.equal(
    workflowStripInput({
      data: "\u001b[B",
      focused: false,
      available: true,
      editorEmpty: true,
    }),
    "focus",
  );
  assert.equal(
    workflowStripInput({
      data: "\u001b[B",
      focused: false,
      available: true,
      editorEmpty: false,
    }),
    undefined,
  );
  assert.equal(
    workflowStripInput({
      data: "\u001b[B",
      focused: false,
      available: false,
      editorEmpty: true,
    }),
    undefined,
  );
});

test("the focused strip opens right, backs out left, and never traps typing", () => {
  for (const data of ["\r", "\u001b[C"]) {
    assert.equal(
      workflowStripInput({
        data,
        focused: true,
        available: true,
        editorEmpty: true,
      }),
      "open",
    );
  }
  for (const data of ["\u001b[A", "\u001b[D", "\u001b"]) {
    assert.equal(
      workflowStripInput({
        data,
        focused: true,
        available: true,
        editorEmpty: true,
      }),
      "blur",
    );
  }
  assert.equal(
    workflowStripInput({
      data: "\u001b[B",
      focused: true,
      available: true,
      editorEmpty: true,
    }),
    "next",
  );
  assert.equal(
    workflowStripInput({
      data: "x",
      focused: true,
      available: true,
      editorEmpty: true,
    }),
    undefined,
  );
});

test("the editor wrapper owns strip keys without changing normal editor input", () => {
  const inputs: string[] = [];
  let text = "";
  const base = {
    render: () => [">"],
    invalidate() {},
    handleInput: (data: string) => inputs.push(data),
    getText: () => text,
    setText: (value: string) => {
      text = value;
    },
  } as EditorComponent;
  const strip = new WorkflowStripState();
  let opened = 0;
  const editor = new WorkflowNavigationEditor(
    base,
    { matches: () => false } as unknown as KeybindingsManager,
    strip,
    () => true,
    () => {
      opened += 1;
    },
    () => {},
  );

  editor.handleInput("\u001b[B");
  assert.equal(strip.focused, true);
  assert.deepEqual(inputs, []);
  editor.handleInput("\u001b[C");
  assert.equal(opened, 1);

  text = "draft";
  editor.handleInput("\u001b[B");
  assert.deepEqual(inputs, ["\u001b[B"]);
});

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function workflow(): WorkflowDetails {
  return {
    runId: "wf_test",
    name: "repair-docs",
    description: "Restore missing chapters",
    background: true,
    status: "running",
    startedAt: Date.now() - 10_000,
    currentPhase: "Draft",
    phases: [{ title: "Draft" }, { title: "Review" }],
    agents: [
      {
        index: 1,
        label: "chapter-2",
        phase: "Draft",
        state: "running",
        startedAt: Date.now() - 9_000,
        preview: "",
        usage: {
          input: 1_200,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
        },
        transcript: [],
      },
    ],
  };
}

test("workflow strip sanitizes restored or legacy metadata defensively", () => {
  const details = workflow();
  details.name = "audit\u001b]52;c;clipboard\u0007\nnow";
  details.currentPhase = "Scan\u001b[31m\u001b[0m";
  const widget = new WorkflowStripWidget(
    { requestRender() {} } as unknown as TUI,
    theme,
    new WorkflowStripState(),
    () => ({ runId: "wf_test", details }),
  );
  try {
    const line = widget.render(100)[0] ?? "";
    assert.match(line, /audit now/);
    assert.doesNotMatch(line, /clipboard|\u001b/);
  } finally {
    widget.dispose();
  }
});

test("the workflow HUD stays bounded and exposes its navigation hint", () => {
  const strip = new WorkflowStripState();
  const tui = { requestRender() {} } as unknown as TUI;
  const widget = new WorkflowStripWidget(tui, theme, strip, () => ({
    runId: "wf_test",
    details: workflow(),
  }));
  try {
    const idle = widget.render(100);
    // Header + one row per agent (the fixture carries one).
    assert.equal(idle.length, 2);
    assert.match(idle[0]!, /repair-docs/);
    assert.match(idle[0]!, /↓ to manage/);
    assert.match(idle[1]!, /chapter-2/);

    strip.focused = true;
    const focused = widget.render(56);
    assert.equal(focused.length, 2);
    for (const line of focused) assert.ok(visibleWidth(line) <= 56);
    assert.match(focused[0]!, /enter open/);
  } finally {
    widget.dispose();
  }
});
