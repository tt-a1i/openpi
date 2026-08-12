import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TASKS_LIMITS,
  TaskRestoreError,
  TaskValidationError,
  applyTaskAdd,
  applyTaskUpdate,
  createSessionTasks,
  emptyTaskSnapshot,
  markdownToTasks,
  nextActionableTask,
  normalizeForTaskMatch,
  projectTasks,
  renderTaskList,
  restoreTaskSnapshot,
  taskMatchesDescription,
  tasksToMarkdown,
  validateTaskSnapshot,
  type TaskSnapshot,
  type TaskStatus,
} from "./tasks.ts";

function snapshot(
  revision: number,
  items: TaskSnapshot["items"] = [],
  nextId = items.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
): TaskSnapshot {
  return { version: 1, revision, nextId, items };
}

function entry(data: unknown) {
  return {
    type: "custom",
    id: `entry-${Math.random()}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: "session-tasks",
    data,
  };
}

test("add, update, list, and stable allocation", () => {
  const tasks = createSessionTasks();
  const added = tasks.add([
    { subject: "First", detail: "one" },
    { subject: "Second" },
  ]);
  tasks.commit(added.snapshot);
  assert.deepEqual(
    added.items.map((item) => item.id),
    [1, 2],
  );
  assert.equal(added.snapshot.revision, 1);

  tasks.commit(tasks.update({ id: 1, subject: "First revised" }).snapshot);
  const third = tasks.add({ subject: "Third" });
  tasks.commit(third.snapshot);
  assert.equal(third.items[0].id, 3);
  assert.deepEqual(tasks.list({ id: 1 }), [
    {
      id: 1,
      subject: "First revised",
      detail: "one",
      status: "pending",
    },
  ]);
  assert.equal(tasks.snapshot().revision, 3);
});

test("completed batches reset immediately and the next batch restarts at T1", () => {
  const tasks = createSessionTasks();
  tasks.commit(
    tasks.add([{ subject: "Build" }, { subject: "Verify" }]).snapshot,
  );
  tasks.commit(
    tasks.update({ id: 1, status: "done", note: "implementation complete" })
      .snapshot,
  );
  assert.deepEqual(
    tasks.list().map((item) => item.id),
    [1, 2],
  );

  const closed = tasks.update({
    id: 2,
    status: "done",
    note: "tests passed",
  });
  assert.deepEqual(closed.items, [
    { id: 2, subject: "Verify", status: "done", note: "tests passed" },
  ]);
  tasks.commit(closed.snapshot);
  assert.deepEqual(tasks.snapshot(), {
    version: 1,
    revision: 3,
    nextId: 1,
    items: [],
  });

  const next = tasks.add({ subject: "New request" });
  assert.equal(next.items[0]?.id, 1);
  assert.equal(next.snapshot.revision, 4);
});

test("all status transitions are allowed; starting a task demotes prior in-flight ones", () => {
  const statuses: TaskStatus[] = [
    "pending",
    "in_progress",
    "blocked",
    "done",
    "dropped",
  ];
  for (const from of statuses) {
    for (const to of statuses) {
      const initial = snapshot(1, [
        {
          id: 1,
          subject: "Transition",
          status: from,
          ...(["blocked", "done", "dropped"].includes(from)
            ? { note: "existing note" }
            : {}),
        },
      ]);
      const tasks = createSessionTasks(initial);
      if (to !== from) {
        tasks.commit(
          tasks.update({
            id: 1,
            status: to,
            ...(["blocked", "done", "dropped"].includes(to)
              ? { note: "fresh note" }
              : {}),
          }).snapshot,
        );
        if (to === "done" || to === "dropped") {
          assert.deepEqual(tasks.list(), []);
        } else {
          assert.equal(tasks.list()[0].status, to);
        }
      } else {
        assert.equal(tasks.list()[0].status, to);
      }
    }
  }

  // Single in-progress invariant (omp's normalizeInProgressTask): starting
  // B demotes A back to pending, so exactly one item is in flight.
  const tasks = createSessionTasks();
  tasks.commit(tasks.add([{ subject: "A" }, { subject: "B" }]).snapshot);
  tasks.commit(tasks.update({ id: 1, status: "in_progress" }).snapshot);
  tasks.commit(tasks.update({ id: 2, status: "in_progress" }).snapshot);
  const inFlight = tasks.list({ status: "in_progress" });
  assert.equal(inFlight.length, 1);
  assert.equal(inFlight[0]?.id, 2);
  assert.equal(tasks.list({ id: 1 })[0]?.status, "pending");
});

test("status entry requires a fresh note and stale notes clear only on leaving", () => {
  const tasks = createSessionTasks();
  tasks.commit(
    tasks.add([{ subject: "Work" }, { subject: "Keep batch open" }]).snapshot,
  );
  for (const status of ["blocked", "done", "dropped"] as const) {
    assert.throws(
      () => tasks.update({ id: 1, status }),
      /fresh note is required/,
    );
  }

  tasks.commit(
    tasks.update({ id: 1, status: "blocked", note: "Waiting for access" })
      .snapshot,
  );
  tasks.commit(tasks.update({ id: 1, subject: "Work renamed" }).snapshot);
  assert.equal(tasks.list()[0].note, "Waiting for access");
  const noOp = tasks.update({ id: 1, status: "blocked" });
  assert.equal(noOp.snapshot.revision, tasks.snapshot().revision);
  assert.equal(tasks.list()[0].note, "Waiting for access");

  tasks.commit(tasks.update({ id: 1, status: "in_progress" }).snapshot);
  assert.equal(tasks.list()[0].note, undefined);
  tasks.commit(
    tasks.update({ id: 1, status: "done", note: "tests passed" }).snapshot,
  );
  tasks.commit(
    tasks.update({ id: 1, status: "pending", note: "reopened intentionally" })
      .snapshot,
  );
  assert.equal(tasks.list({ id: 1 })[0].note, "reopened intentionally");
});

test("strict snapshot validation rejects unknown fields, bad notes, duplicate IDs, limits, and bytes", () => {
  assert.throws(
    () =>
      validateTaskSnapshot({
        ...emptyTaskSnapshot(),
        extra: true,
      }),
    /unknown field/,
  );
  assert.throws(
    () =>
      validateTaskSnapshot(
        snapshot(1, [{ id: 1, subject: "Blocked", status: "blocked" }]),
      ),
    /note is required/,
  );
  assert.throws(
    () =>
      validateTaskSnapshot(
        snapshot(1, [
          { id: 1, subject: "A", status: "pending" },
          { id: 1, subject: "B", status: "pending" },
        ]),
      ),
    /duplicate task id/,
  );
  assert.throws(
    () =>
      validateTaskSnapshot(
        snapshot(1, [
          {
            id: 1,
            subject: "x".repeat(TASKS_LIMITS.subjectChars + 1),
            status: "pending",
          },
        ]),
      ),
    /subject exceeds/,
  );
  assert.throws(
    () =>
      validateTaskSnapshot(
        snapshot(1, [{ id: 2, subject: "bad nextId", status: "pending" }], 2),
      ),
    /nextId must be greater/,
  );
  const tooLarge = snapshot(
    1,
    Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      subject: "界".repeat(40),
      detail: "界".repeat(500),
      status: "pending" as const,
      note: "界".repeat(500),
    })),
    101,
  );
  assert.throws(() => validateTaskSnapshot(tooLarge), /UTF-8 bytes/);
});

test("batch and item caps are enforced", () => {
  assert.throws(
    () =>
      applyTaskAdd(
        emptyTaskSnapshot(),
        Array.from({ length: 21 }, (_, index) => ({ subject: `T${index}` })),
      ),
    /batch exceeds 20/,
  );
  const full = snapshot(
    1,
    Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      subject: `T${index + 1}`,
      status: "pending" as const,
    })),
    101,
  );
  assert.throws(
    () => applyTaskAdd(full, [{ subject: "overflow" }]),
    /100 items/,
  );
});

test("oversized candidate is rejected before mutable task-state commit", () => {
  const tasks = createSessionTasks();
  tasks.commit(
    tasks.add(
      Array.from({ length: 20 }, (_, index) => ({
        subject: `Seed ${index}`,
        detail: "a".repeat(220),
        note: "a".repeat(220),
      })),
    ).snapshot,
  );
  const before = tasks.snapshot();
  const huge = Array.from({ length: 20 }, (_, index) => ({
    subject: `Huge ${index}`,
    detail: "界".repeat(500),
    note: "界".repeat(500),
  }));
  assert.throws(() => tasks.add(huge), /UTF-8 bytes/);
  assert.deepEqual(tasks.snapshot(), before);
});

test("restore chooses highest revision regardless of position and later entry wins ties", () => {
  const revision3Early = snapshot(3, [
    { id: 3, subject: "revision three", status: "pending" },
  ]);
  const revision2Late = snapshot(2, [
    { id: 2, subject: "revision two", status: "pending" },
  ]);
  assert.equal(
    restoreTaskSnapshot([entry(revision3Early), entry(revision2Late)]).revision,
    3,
  );

  const tieLate = snapshot(3, [
    { id: 7, subject: "later tie", status: "pending" },
  ]);
  assert.equal(
    restoreTaskSnapshot([entry(revision3Early), entry(tieLate)]).items[0].id,
    7,
  );
});

test("foreign session entries are ignored by restore", () => {
  const valid = entry(
    snapshot(1, [{ id: 1, subject: "valid", status: "pending" }]),
  );
  const foreign = [
    { type: "message", version: 99, revision: 999, items: "bad" },
    { type: "compaction", version: 99, revision: 999, items: "bad" },
    {
      type: "custom",
      customType: "another-extension",
      data: { version: 99, revision: 999, items: "bad" },
    },
  ];
  assert.equal(restoreTaskSnapshot([valid, ...foreign]).revision, 1);
});

test("malformed winner and later malformed or unknown entries fail closed", () => {
  const valid = snapshot(5, [{ id: 5, subject: "valid", status: "pending" }]);
  assert.throws(
    () =>
      restoreTaskSnapshot([
        entry(valid),
        entry({ version: 1, revision: 6, nextId: 6, items: "bad" }),
      ]),
    TaskRestoreError,
  );
  assert.throws(
    () => restoreTaskSnapshot([entry(valid), entry({ version: 2 })]),
    /locks restoration/,
  );
  assert.throws(
    () =>
      restoreTaskSnapshot([
        entry(valid),
        entry({ version: 2, revision: 99, nextId: 100, items: [] }),
      ]),
    /winning task revision 99 is malformed/,
  );
  assert.throws(
    () => restoreTaskSnapshot([entry(valid), entry({ garbage: true })]),
    /locks restoration/,
  );
  assert.throws(
    () =>
      restoreTaskSnapshot([
        entry(valid),
        { type: "custom", customType: "session-tasks" },
      ]),
    /locks restoration/,
  );
});

test("restore closes legacy terminal-only batches and restarts their IDs", () => {
  const restored = restoreTaskSnapshot([
    entry(
      snapshot(
        3,
        [
          { id: 1, subject: "done", status: "done", note: "verified" },
          { id: 2, subject: "dropped", status: "dropped", note: "obsolete" },
        ],
        3,
      ),
    ),
  ]);
  assert.deepEqual(restored, {
    version: 1,
    revision: 3,
    nextId: 1,
    items: [],
  });
  assert.equal(
    createSessionTasks(restored).add({ subject: "next request" }).items[0].id,
    1,
  );
});

test("reload after a legacy completed batch keeps the new batch numbering local", () => {
  const legacyClosed = snapshot(
    7,
    [{ id: 79, subject: "old done", status: "done", note: "verified" }],
    80,
  );
  const newBatch = snapshot(
    8,
    [{ id: 1, subject: "new request", status: "pending" }],
    2,
  );
  const restored = restoreTaskSnapshot([entry(legacyClosed), entry(newBatch)]);
  assert.equal(restored.nextId, 2);
  assert.equal(
    createSessionTasks(restored).add({ subject: "second new task" }).items[0]
      .id,
    2,
  );
});

test("restore high-water nextId prevents ID rewind inside an active batch", () => {
  const restored = restoreTaskSnapshot([
    entry(snapshot(3, [], 80)),
    entry(snapshot(4, [{ id: 42, subject: "high id", status: "pending" }], 43)),
  ]);
  assert.equal(restored.nextId, 80);
  assert.equal(
    createSessionTasks(restored).add({ subject: "next" }).items[0].id,
    80,
  );
});

test("concurrent sibling completion order survives reload by monotonic revision", () => {
  const tasks = createSessionTasks();
  const first = tasks.add({ subject: "first completed mutation" }).snapshot;
  tasks.commit(first);
  const second = tasks.add({ subject: "second completed mutation" }).snapshot;
  tasks.commit(second);

  // A session writer may place sibling results out of completion order.
  const restored = restoreTaskSnapshot([entry(second), entry(first)]);
  assert.equal(restored.revision, 2);
  assert.deepEqual(
    restored.items.map((item) => item.subject),
    ["first completed mutation", "second completed mutation"],
  );
});

test("branch slices model new, resume, tree, fork, and context-pivot semantics", () => {
  const root = snapshot(1, [{ id: 1, subject: "root", status: "pending" }]);
  const left = snapshot(2, [{ id: 1, subject: "left", status: "in_progress" }]);
  const right = snapshot(2, [
    { id: 1, subject: "right", status: "blocked", note: "branch reason" },
  ]);

  assert.deepEqual(restoreTaskSnapshot([]), emptyTaskSnapshot()); // /new
  assert.equal(
    restoreTaskSnapshot([entry(root), entry(left)]).items[0].subject,
    "left",
  ); // resume/tree
  assert.equal(restoreTaskSnapshot([entry(root)]).nextId, 2); // fork at root
  assert.equal(
    restoreTaskSnapshot([entry(root), { type: "context-pivot" }, entry(right)])
      .items[0].subject,
    "right",
  );
});

test("projection is empty without actionable work, prioritized, advisory, and bounded", () => {
  assert.equal(projectTasks(emptyTaskSnapshot()), "");
  assert.equal(
    projectTasks(
      snapshot(1, [{ id: 1, subject: "finished", status: "done", note: "ok" }]),
    ),
    "",
  );

  const projected = projectTasks(
    snapshot(1, [
      { id: 1, subject: "pending", status: "pending" },
      { id: 2, subject: "blocked", status: "blocked", note: "reason" },
      { id: 3, subject: "active", status: "in_progress" },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: index + 4,
        subject: "long pending subject ".repeat(5),
        status: "pending" as const,
      })),
    ]),
  );
  assert.match(projected, /advisory context, not an instruction/);
  assert.match(
    projected,
    /Real files, git, tests, tools, artifacts, and user confirmation are truth/,
  );
  assert.match(projected, /tasks_list/);
  assert.match(projected, /compaction\/pivot/);
  assert.ok(projected.indexOf("T3") < projected.indexOf("T2"));
  assert.ok(projected.indexOf("T2") < projected.indexOf("T1"));
  assert.ok(Array.from(projected).length <= 800);
});

test("render list supports combined id/status filters and character bounds", () => {
  const state = snapshot(1, [
    { id: 1, subject: "one", status: "pending" },
    {
      id: 2,
      subject: "two",
      detail: "detail",
      status: "blocked",
      note: "reason",
    },
  ]);
  assert.equal(
    renderTaskList(state, { id: 2, status: "blocked" }),
    "T2 [blocked] two\n  detail: detail\n  note: reason",
  );
  assert.equal(
    renderTaskList(state, { id: 2, status: "pending" }),
    "No task items.",
  );
  assert.equal(Array.from(renderTaskList(state, {}, 12)).length, 12);
});

test("apply functions are synchronous and returned state cannot mutate internal state", () => {
  const tasks = createSessionTasks();
  const result = tasks.add({ subject: "immutable" });
  assert.equal(result instanceof Promise, false);
  assert.equal(
    tasks.list().length,
    0,
    "candidate must not commit before persistence",
  );
  tasks.commit(result.snapshot);
  result.snapshot.items[0].subject = "external mutation";
  result.items[0].subject = "external mutation";
  assert.equal(tasks.list()[0].subject, "immutable");

  const candidate = applyTaskAdd(tasks.snapshot(), [
    { subject: "committed after persistence" },
  ]).snapshot;
  tasks.commit(candidate);
  assert.equal(tasks.list()[1].subject, "committed after persistence");
});

test("no-op updates are idempotent without advancing the revision", () => {
  const tasks = createSessionTasks();
  tasks.commit(tasks.add({ subject: "same" }).snapshot);
  const before = tasks.snapshot();
  const noOp = tasks.update({ id: 1, subject: "same" });
  assert.equal(noOp.snapshot.revision, before.revision);
  assert.deepEqual(tasks.snapshot(), before);
});

test("validation errors have a stable public class", () => {
  assert.throws(
    () => createSessionTasks().add({ subject: "" }),
    TaskValidationError,
  );
  assert.throws(
    () => createSessionTasks().add({ subject: "bad\u0007subject" }),
    /control characters/,
  );
});

test("ordinary newlines and tabs normalize to a single line", () => {
  const tasks = createSessionTasks();
  const added = tasks.add([
    {
      subject: "Fix\tbug",
      detail: "command\noutput",
    },
    { subject: "Keep batch open" },
  ]);
  tasks.commit(added.snapshot);
  const done = tasks.update({
    id: 1,
    status: "done",
    note: "npm test\n21 passed",
  });
  tasks.commit(done.snapshot);
  assert.deepEqual(tasks.list()[0], {
    id: 1,
    subject: "Fix bug",
    detail: "command output",
    status: "done",
    note: "npm test 21 passed",
  });
});

test("nextActionableTask prefers in-flight over oldest pending, excludes blocked", () => {
  assert.equal(
    nextActionableTask([
      { id: 1, subject: "blocked one", status: "blocked", note: "wait" },
      { id: 2, subject: "old open", status: "pending" },
      { id: 3, subject: "in flight", status: "in_progress" },
      { id: 4, subject: "done one", status: "done", note: "ok" },
    ])?.id,
    3,
  );
  assert.equal(
    nextActionableTask([
      { id: 2, subject: "old open", status: "pending" },
      { id: 5, subject: "newer open", status: "pending" },
    ])?.id,
    2,
  );
  assert.equal(
    nextActionableTask([
      { id: 1, subject: "blocked one", status: "blocked", note: "wait" },
    ]),
    undefined,
  );
});

test("task matching normalizes case, spacing, and punctuation", () => {
  assert.equal(taskMatchesDescription("Fix bug", "fix bug"), true);
  assert.equal(taskMatchesDescription("Fix bug", "Fix\tbug!"), true);
  assert.equal(
    taskMatchesDescription("切片2：四端关卡操作", "切片 2 四端关卡"),
    true,
  ); // substring fallback
  assert.equal(taskMatchesDescription("abc", "abcdefgh"), false); // floor
  assert.equal(
    taskMatchesDescription("unrelated", "completely different"),
    false,
  );
});

test("single in-progress invariant demotes other in-flight items", () => {
  const { snapshot } = applyTaskUpdate(
    {
      version: 1,
      revision: 1,
      nextId: 4,
      items: [
        { id: 1, subject: "A", status: "in_progress" },
        { id: 2, subject: "B", status: "pending" },
      ],
    },
    { id: 2, status: "in_progress" },
  );
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  assert.equal(byId.get(1)?.status, "pending");
  assert.equal(byId.get(2)?.status, "in_progress");
});

test("markdown export/import round-trips statuses, subjects, and notes", () => {
  const snapshot: TaskSnapshot = {
    version: 1 as const,
    revision: 4,
    nextId: 5,
    items: [
      { id: 1, subject: "Setup", status: "done", note: "15 tests passed" },
      { id: 2, subject: "Implement panel", status: "in_progress" },
      { id: 3, subject: "Wait for owner", status: "blocked", note: "裁定" },
      { id: 4, subject: "Scrap idea", status: "dropped", note: "unused" },
    ],
  };
  const markdown = tasksToMarkdown(snapshot);
  assert.match(markdown, /\[x\] Setup -- 15 tests passed/);
  assert.match(markdown, /\[\/\] Implement panel/);
  assert.match(markdown, /\[!\] Wait for owner -- 裁定/);
  const parsed = markdownToTasks(markdown);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(
    parsed.items.map((item) => [
      item.subject,
      item.status ?? "pending",
      item.note,
    ]),
    [
      ["Setup", "done", "15 tests passed"],
      ["Implement panel", "in_progress", undefined],
      ["Wait for owner", "blocked", "裁定"],
      ["Scrap idea", "dropped", "unused"],
    ],
  );
});

test("markdown import reports unrecognized lines and markers", () => {
  const parsed = markdownToTasks(
    "# Tasks\n- [z] bad marker\n- [ ] ok\nnot a list line\n",
  );
  assert.ok(
    parsed.errors.some((error) => error.includes("unknown status marker")),
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]?.subject, "ok");
});
