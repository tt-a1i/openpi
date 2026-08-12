import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  failureStreakOf,
  isStalled,
  lastActivityOf,
  lastIntentOf,
} from "./src/domain.ts";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "scan",
    prompt: "p",
    cwd: "/repo",
    status: "running",
    createdAt: 1_000,
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

test("lastActivityOf falls back to createdAt for legacy snapshots", () => {
  assert.equal(lastActivityOf(snapshot()), 1_000);
  assert.equal(lastActivityOf(snapshot({ lastActivityAt: 5_000 })), 5_000);
});

test("isStalled flags only running agents past the silence threshold", () => {
  const now = 100_000;
  // Legacy snapshot without the field ages from createdAt.
  assert.equal(isStalled(snapshot({ createdAt: 1_000 }), now, 60_000), true);
  assert.equal(isStalled(snapshot({ createdAt: 1_000 }), now, 200_000), false);
  assert.equal(
    isStalled(snapshot({ lastActivityAt: now - 30_000 }), now, 60_000),
    false,
  );
  // Non-running agents are never "stalled" — they are settled.
  assert.equal(
    isStalled(snapshot({ status: "done", settledAt: 5_000 }), now, 1),
    false,
  );
});

test("lastIntentOf prefers live streaming text, then latest assistant text", () => {
  assert.equal(
    lastIntentOf(
      snapshot({
        liveAssistant: { text: "  scanning slices  ", thinking: "" },
      }),
    ),
    "scanning slices",
  );
  assert.equal(
    lastIntentOf(
      snapshot({
        transcript: [
          { kind: "user", text: "go" },
          {
            kind: "assistant",
            parts: [{ type: "thinking", text: "hmm", redacted: true }],
          },
          {
            kind: "assistant",
            parts: [
              { type: "text", text: "  inspecting the registry  " },
              {
                type: "toolCall",
                toolId: "t1",
                name: "read",
                argsPreview: "a",
              },
            ],
          },
        ],
      }),
    ),
    "inspecting the registry",
  );
  assert.equal(lastIntentOf(snapshot()), undefined);
});

test("failureStreakOf defaults to zero", () => {
  assert.equal(failureStreakOf(snapshot()), 0);
  assert.equal(failureStreakOf(snapshot({ consecutiveFailures: 3 })), 3);
});
