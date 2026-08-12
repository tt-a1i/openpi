import assert from "node:assert/strict";
import test from "node:test";
import {
  drainSettledSubagents,
  recordSettledSubagent,
  resetSettledSubagents,
} from "./task-reconcile.ts";

test("records accumulate until drained, then clear", () => {
  resetSettledSubagents();
  assert.deepEqual(drainSettledSubagents(), []);
  recordSettledSubagent({ id: "sa-1", description: "scan slice2", ok: true });
  recordSettledSubagent({ id: "sa-2", description: "review memp", ok: false });
  const drained = drainSettledSubagents();
  assert.equal(drained.length, 2);
  assert.equal(drained[0]?.id, "sa-1");
  assert.equal(drained[1]?.ok, false);
  assert.deepEqual(drainSettledSubagents(), []);
});

test("reset clears without draining", () => {
  resetSettledSubagents();
  recordSettledSubagent({ id: "sa-1", description: "x", ok: true });
  resetSettledSubagents();
  assert.deepEqual(drainSettledSubagents(), []);
});
