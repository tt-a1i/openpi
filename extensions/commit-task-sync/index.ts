/**
 * commit-task-sync: detect successful `git commit` → remind agent to sync tasks.
 *
 * **Problem**: openpi tasks are session-scoped intent tracking with no auto-sync.
 * When an agent commits + pushes (real progress) but forgets `tasks_update`,
 * tasks drift from reality (e.g., T4 blocked→done by owner authorization,
 * but task still shows blocked).
 *
 * **Dual-channel reminder** (v2 enhancement):
 * 1. `pi.on("agent_settled")` → `ctx.ui.notify` (TUI warning, user sees)
 * 2. `pi.on("context")` → `injectCommitReminder` (context injection, agent sees next turn)
 *
 * The context injection is the stronger channel: it appends a `<commit-task-sync>`
 * block to the next turn's messages, so the agent CANNOT miss it (unlike ui.notify
 * which is advisory/TUI-only). Pattern: `injectTaskProjection` in tasks/index.ts.
 *
 * **Pattern**: post-edit extension (`pi.on("tool_result")` flag + `pi.on("agent_settled")` debounce).
 * **Trust surface**: detect `git commit` string in bash command + `!event.isError`.
 * Does NOT execute commands, does NOT auto-modify tasks (agent decides).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Bash commands that indicate a commit happened. */
const COMMIT_PATTERNS = [
  /\bgit\s+commit\b/,
];

/** Reminder text injected into next turn's context (agent-visible). */
const REMINDER_TEXT = `⚠️ 上轮检测到 git commit 成功。请检查 tasks 状态同步：
- 如有完成项（commit/reviewer/授权后 done），**立即 tasks_update done** 带 commit SHA + reviewer 结论
- 如有 blocked→done（业主授权/ADR 落地），同步 status
- 这是 commit-task-sync hook 自动提醒（防 tasks 残留，不靠 agent 记忆力）
commit-task-sync 检测到 commit → 注入此提示到下轮上下文。注入后自动清除（仅提醒一次）。`;

export default function commitTaskSync(pi: ExtensionAPI) {
  let commitDetected = false;
  let generation = 0;

  /**
   * tool_result: hot path. Only flip a boolean.
   * Detects bash tool success with `git commit` in the command.
   */
  pi.on(
    "tool_result",
    (event: { toolName: string; isError?: boolean; input?: unknown; params?: unknown }) => {
      if (event.isError) return;
      if (event.toolName !== "bash") return;

      const command = extractCommand(event);
      if (!command) return;

      if (COMMIT_PATTERNS.some((pattern) => pattern.test(command))) {
        commitDetected = true;
      }
    },
  );

  /**
   * Channel 1 — agent_settled: TUI notify (user-visible, advisory).
   * Does NOT reset commitDetected (context handler owns the reset).
   */
  pi.on("agent_settled", (_event: unknown, ctx: ExtensionContext) => {
    if (!commitDetected) return;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    try {
      ctx.ui.notify(
        "⚠️ git commit 检测到 — 请检查 tasks 状态同步（如有完成项，tasks_update done 带 commit SHA）",
        "warning",
      );
    } catch {
      // Session may have ended; best-effort notification.
    }
  });

  /**
   * Channel 2 — context: inject reminder into next turn's messages (agent-visible, mandatory).
   * This is the STRONGER channel: agent cannot miss it (it's in the conversation context).
   * Resets commitDetected after injection (remind once per commit).
   *
   * Pattern: injectTaskProjection in tasks/index.ts (:483) — return { messages } to replace.
   */
  pi.on("context", (event) => {
    if (!commitDetected) return;
    commitDetected = false; // Inject once, then reset

    const messages = injectCommitReminder(event.messages);
    if (messages) {
      return { messages: messages as typeof event.messages };
    }
  });

  /** Reset on session lifecycle. */
  pi.on("session_start", () => {
    generation++;
    commitDetected = false;
  });

  pi.on("session_shutdown", () => {
    generation++;
    commitDetected = false;
  });
}

/**
 * Inject commit-task-sync reminder into messages (agent-visible next turn).
 * Pattern: injectTaskProjection in tasks/index.ts — clone, append block to last user message.
 */
function injectCommitReminder(messages: unknown[]): unknown[] | undefined {
  const next = structuredClone(messages) as Array<{
    role?: string;
    content?: unknown;
  }>;
  for (let index = next.length - 1; index >= 0; index--) {
    const message = next[index];
    if (message.role !== "user") continue;
    const block = {
      type: "text",
      text: `\n\n<commit-task-sync>\n${REMINDER_TEXT}\n</commit-task-sync>`,
    };
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }, block];
    } else if (Array.isArray(message.content)) {
      message.content.push(block);
    } else {
      return undefined;
    }
    return next;
  }
  return undefined;
}

/**
 * Extract the bash command string from a tool_result event.
 * Pi's event shape may vary; try common field names.
 */
function extractCommand(event: {
  input?: unknown;
  params?: unknown;
}): string | null {
  // Try input.command (object with command field)
  const fromInput =
    typeof event.input === "object" && event.input !== null
      ? (event.input as Record<string, unknown>).command
      : undefined;
  if (typeof fromInput === "string") return fromInput;

  // Try params.command
  const fromParams =
    typeof event.params === "object" && event.params !== null
      ? (event.params as Record<string, unknown>).command
      : undefined;
  if (typeof fromParams === "string") return fromParams;

  // Try input as string directly
  if (typeof event.input === "string") return event.input;

  // Try params as string directly
  if (typeof event.params === "string") return event.params;

  return null;
}
