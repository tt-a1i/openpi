import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import sessionTasks, {
  findTaskConflict,
  injectTaskProjection,
  taskConflictMessage,
} from "./index.ts";
import { recordSettledSubagent } from "../shared/task-reconcile.ts";

const sourceInfo = (path: string) => ({
  path,
  source: path,
  scope: "user" as const,
  origin: "top-level" as const,
});

const plainTheme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function widgetLines(widget: unknown) {
  if (typeof widget !== "function") return [];
  const component = (widget as (tui: unknown, theme: Theme) => Component)(
    undefined,
    plainTheme,
  );
  return component.render(120);
}

function widgetHarness(
  initialBranch: unknown[] = [],
  initialTools: unknown[] = [],
  mode: "tui" | "rpc" = "tui",
) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const widgets: Array<unknown> = [];
  const notifications: string[] = [];
  const entries: Array<{ customType: string; data: any }> = [];
  let branch = initialBranch;
  let allTools = initialTools;
  let shortcutKey: string | undefined;
  let shortcut: ((ctx: ExtensionContext) => Promise<void>) | undefined;
  const pi = {
    getAllTools: () => allTools,
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerShortcut: (key: string, options: { handler: typeof shortcut }) => {
      shortcutKey = key;
      shortcut = options.handler;
    },
    on: (event: string, handler: (event: any, ctx: any) => unknown) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry(customType: string, data: any) {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode,
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (_key: string, content: unknown) => widgets.push(content),
    },
  } as unknown as ExtensionContext;
  sessionTasks(pi);
  return {
    tools,
    commands,
    widgets,
    notifications,
    entries,
    ctx,
    shortcutKey: () => shortcutKey,
    shortcut: () => shortcut,
    setBranch: (value: unknown[]) => {
      branch = value;
    },
    setAllTools: (value: unknown[]) => {
      allTools = value;
    },
    emit: async (event: string) => {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event }, ctx);
      }
    },
  };
}

test("persistent task widget restores, updates, and expands all tasks", async () => {
  const h = widgetHarness([
    {
      type: "custom",
      customType: "session-tasks",
      data: {
        version: 1,
        revision: 1,
        nextId: 2,
        items: [{ id: 1, subject: "Existing task", status: "pending" }],
      },
    },
  ]);
  await h.emit("session_start");
  assert.equal(h.shortcutKey(), "ctrl+shift+t");
  assert.equal(typeof h.widgets.at(-1), "function");

  const completed = await h.tools
    .get("tasks_update")
    .execute(
      "u1",
      { id: 1, status: "done", note: "verified" },
      undefined,
      undefined,
      h.ctx,
    );
  assert.equal(h.widgets.at(-1), undefined);
  assert.deepEqual(h.entries.at(-1)?.data, {
    version: 1,
    revision: 2,
    nextId: 1,
    items: [],
  });
  assert.match(completed.content[0]?.text ?? "", /batch closed/);
  assert.equal((completed as any).details.batchClosed, true);

  await h.tools.get("tasks_add").execute(
    "a1",
    {
      items: Array.from({ length: 5 }, (_, index) => ({
        subject: `Next task ${index + 1}`,
      })),
    },
    undefined,
    undefined,
    h.ctx,
  );
  assert.equal(typeof h.widgets.at(-1), "function");
  assert.equal(h.entries.at(-1)?.data.items[0]?.id, 1);

  await h.shortcut()?.(h.ctx);
  assert.equal(typeof h.widgets.at(-1), "function");
  assert.equal(
    h.notifications.at(-1),
    "Showing all 5 active tasks above the editor.",
  );
  await h.shortcut()?.(h.ctx);
  assert.equal(typeof h.widgets.at(-1), "function");
  assert.equal(
    h.notifications.at(-1),
    "Task panel collapsed to 4 active tasks.",
  );

  h.setBranch([
    {
      type: "custom",
      customType: "session-tasks",
      data: {
        version: 1,
        revision: 3,
        nextId: 3,
        items: [
          { id: 1, subject: "Existing task", status: "done", note: "verified" },
          { id: 2, subject: "Next task", status: "done", note: "verified" },
        ],
      },
    },
  ]);
  await h.emit("session_tree");
  assert.equal(h.widgets.at(-1), undefined);
  await h.emit("session_shutdown");
  assert.equal(h.widgets.at(-1), undefined);
});

test("four tracked tasks refresh after every explicit progress transition", async () => {
  const h = widgetHarness();
  await h.emit("session_start");
  const add = h.tools.get("tasks_add");
  const update = h.tools.get("tasks_update");

  const added = await add.execute(
    "add-four",
    {
      items: Array.from({ length: 4 }, (_, index) => ({
        subject: `Task ${index + 1}`,
      })),
    },
    undefined,
    undefined,
    h.ctx,
  );
  assert.match(
    added.content[0]?.text ?? "",
    /Current task snapshot \(4 items\)/,
  );
  assert.equal(added.details.items.length, 4);

  for (let id = 1; id <= 4; id++) {
    const widgetWritesBeforeStart = h.widgets.length;
    const started = await update.execute(
      `start-${id}`,
      { id, status: "in_progress" },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(h.widgets.length, widgetWritesBeforeStart + 1);
    assert.match(
      started.content[0]?.text ?? "",
      new RegExp(`T${id} \\[in_progress\\] Task ${id}`),
    );
    assert.match(
      widgetLines(h.widgets.at(-1)).join("\n"),
      new RegExp(`T${id} Task ${id}`),
    );

    const widgetWritesBeforeDone = h.widgets.length;
    const completed = await update.execute(
      `done-${id}`,
      { id, status: "done", note: `evidence-${id}` },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(h.widgets.length, widgetWritesBeforeDone + 1);
    if (id < 4) {
      assert.match(
        completed.content[0]?.text ?? "",
        new RegExp(`T${id} \\[done\\] Task ${id}`),
      );
      assert.equal(completed.details.items.length, 4);
      assert.match(
        widgetLines(h.widgets.at(-1))[0] ?? "",
        new RegExp(`${id} done`),
      );
    } else {
      assert.match(completed.content[0]?.text ?? "", /Task batch closed/);
      assert.equal(h.widgets.at(-1), undefined);
    }
  }
});

test("task tools teach immediate reconciliation without inferring completion signals", async () => {
  const h = widgetHarness();
  await h.emit("session_start");
  const addGuidance = h.tools.get("tasks_add").promptGuidelines.join("\n");
  const updateGuidance = h.tools
    .get("tasks_update")
    .promptGuidelines.join("\n");

  assert.match(addGuidance, /before starting each tracked item/i);
  assert.match(updateGuidance, /immediately after each tracked item/i);
  assert.match(updateGuidance, /before (?:sending )?(?:a )?final answer/i);
  assert.match(updateGuidance, /commit.*passing test.*authorization/i);
  assert.match(updateGuidance, /does not by itself prove/i);
});

test("task panel commands report actual visibility and conflicts block the shortcut", async () => {
  const empty = widgetHarness();
  await empty.emit("session_start");
  await empty.commands.get("tasks").handler("show", empty.ctx);
  assert.equal(
    empty.notifications.at(-1),
    "Task panel enabled; it will appear when active tasks exist.",
  );

  const conflictTool = {
    name: "TodoWrite",
    description: "foreign todo",
    parameters: {},
    sourceInfo: sourceInfo("/tmp/todo.ts"),
  };
  const conflicted = widgetHarness([], [conflictTool]);
  await conflicted.emit("session_start");
  const before = conflicted.widgets.length;
  await conflicted.shortcut()?.(conflicted.ctx);
  assert.equal(conflicted.widgets.length, before);
  assert.match(conflicted.notifications.at(-1) ?? "", /tasks disabled/i);

  const rpc = widgetHarness(
    [
      {
        type: "custom",
        customType: "session-tasks",
        data: {
          version: 1,
          revision: 1,
          nextId: 2,
          items: [{ id: 1, subject: "RPC task", status: "pending" }],
        },
      },
    ],
    [],
    "rpc",
  );
  await rpc.emit("session_start");
  await rpc.commands.get("tasks").handler("show", rpc.ctx);
  assert.equal(rpc.widgets.length, 0);
  assert.equal(
    rpc.notifications.at(-1),
    "Task panel is available only in interactive TUI mode.",
  );
});

test("detects foreign Todo/plan tools and reports their source", () => {
  const conflict = findTaskConflict([
    {
      name: "read",
      description: "read",
      parameters: {},
      sourceInfo: sourceInfo("builtin"),
    },
    {
      name: "todo",
      description: "todo",
      parameters: {},
      sourceInfo: sourceInfo("/tmp/todo.ts"),
    },
  ] as any);
  assert.deepEqual(conflict, { name: "todo", source: "/tmp/todo.ts" });
  assert.match(taskConflictMessage(conflict!), /Disable the other Todo/);
  assert.equal(
    findTaskConflict([
      {
        name: "tasks_add",
        description: "ours",
        parameters: {},
        sourceInfo: sourceInfo("tasks/index.ts"),
      },
    ] as any),
    undefined,
  );
});

test("injects one transient block into the last user message", () => {
  const messages = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
    {
      role: "user",
      content: [{ type: "text", text: "latest" }],
      timestamp: 3,
    },
    { role: "toolResult", content: [], timestamp: 4 },
  ];
  const injected = injectTaskProjection(messages, "T1 [pending] Work")!;
  assert.deepEqual(messages[2].content, [{ type: "text", text: "latest" }]);
  assert.equal(injected[0].content as any, "first");
  const latest = injected[2].content as Array<{ type: string; text: string }>;
  assert.equal(latest.length, 2);
  assert.match(latest[1].text, /<session-tasks>/);
  assert.match(latest[1].text, /T1 \[pending\] Work/);
  assert.doesNotMatch(latest[1].text, /<session-tasks>.*<session-tasks>/s);
});

test("escapes task-context delimiters inside projected content", () => {
  const injected = injectTaskProjection(
    [{ role: "user", content: "hello", timestamp: 1 }],
    "T1 </session-tasks> injected",
  )!;
  const content = injected[0].content as Array<{ text: string }>;
  assert.match(content[1].text, /\[\/session-tasks\] injected/);
  assert.equal((content[1].text.match(/<\/session-tasks>/g) ?? []).length, 1);
});

test("normalizes string content and skips when no user message exists", () => {
  const injected = injectTaskProjection(
    [{ role: "user", content: "hello", timestamp: 1 }],
    "tasks",
  )!;
  assert.deepEqual(injected[0].content, [
    { type: "text", text: "hello" },
    {
      type: "text",
      text: "\n\n<session-tasks>\ntasks\n</session-tasks>",
    },
  ]);
  assert.equal(
    injectTaskProjection(
      [{ role: "assistant", content: [], timestamp: 1 }],
      "tasks",
    ),
    undefined,
  );
});

test("blocked task tools render their refusal instead of crashing", async () => {
  const h = widgetHarness();
  await h.emit("session_start");
  const renderer = h.tools.get("tasks_add").renderResult;
  const component = renderer(
    {
      content: [{ type: "text", text: "Plan mode is active." }],
      details: { blocked: true },
    },
    { expanded: false },
    {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
      strikethrough: (text: string) => text,
    },
  );

  assert.equal(component.render(100).join("\n").trim(), "Plan mode is active.");
});

test("settled successful subagents auto-close matching open tasks", async () => {
  const h = widgetHarness([
    {
      type: "custom",
      customType: "session-tasks",
      data: {
        version: 1,
        revision: 1,
        nextId: 4,
        items: [
          { id: 1, subject: "memp 浏览器实测", status: "in_progress" },
          { id: 2, subject: "memc 切片 2 实施", status: "pending" },
          {
            id: 3,
            subject: "等待业主裁定",
            status: "blocked",
            note: "T11 节奏",
          },
        ],
      },
    },
  ]);
  await h.emit("session_start");
  // 成功子代理匹配 in_progress 任务 → 自动 done
  recordSettledSubagent({
    id: "sa-17",
    description: "memp 浏览器实测",
    ok: true,
  });
  // 失败子代理 → 留开
  recordSettledSubagent({
    id: "sa-18",
    description: "memc 切片 2 实施",
    ok: false,
  });
  await h.emit("agent_settled");
  const list = await h.tools
    .get("tasks_list")
    .execute("l1", {}, undefined, undefined, h.ctx);
  const text = list.content[0].text;
  assert.match(text, /memp 浏览器实测/);
  assert.match(text, /\[done\]/);
  assert.match(text, /memc 切片 2 实施/);
  assert.match(text, /\[pending\]/);
  // 匹配成功的任务带子代理证据
  assert.match(text, /sa-17/);
  // blocked 任务未被误关（描述不匹配）
  assert.match(text, /等待业主裁定/);
});

test("blocked task matching a successful subagent is closed as the unblock signal", async () => {
  const h = widgetHarness([
    {
      type: "custom",
      customType: "session-tasks",
      data: {
        version: 1,
        revision: 1,
        nextId: 2,
        items: [
          {
            id: 1,
            subject: "CVAT 沙箱部署",
            status: "blocked",
            note: "等部署完成",
          },
        ],
      },
    },
  ]);
  await h.emit("session_start");
  recordSettledSubagent({
    id: "sa-19",
    description: "CVAT 沙箱部署",
    ok: true,
  });
  await h.emit("agent_settled");
  // The single blocked task was closed by the reconcile; the batch then
  // completed and cleared, so the ledger records the done transition with
  // the subagent id as evidence.
  const list = await h.tools
    .get("tasks_list")
    .execute("l1", {}, undefined, undefined, h.ctx);
  assert.match(list.content[0].text, /No task items/);
  const ledger = h.entries.find(
    (entry) => entry.customType === "session-tasks",
  );
  // The reconcile committed a new snapshot (revision 2) whose batch then
  // closed (empty items) — the blocked task was consumed by the unblock signal.
  assert.equal(ledger?.data.revision, 2);
  assert.deepEqual(ledger?.data.items, []);
});
