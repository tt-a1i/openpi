/**
 * multi-signal-sync: MECE task-completion signals → remind agent to sync tasks.
 *
 * Upgrades commit-task-sync (single A signal) to full MECE coverage:
 * - **A. commit**  (git commit exit 0)          — via tool_result
 * - **B. verify**  (tsc/test/verify PASS exit 0) — via tool_result
 * - **C. auth**    (owner authorization in user message) — via context
 *
 * **First principles**: task status (in_progress/blocked → done) should be
 * driven by REAL completion signals, not agent memory. MECE decomposition of
 * completion signals = commit / verify / authorization / no-change (D) /
 * cancelled (E). D/E have no signal (agent discipline + closeout audit);
 * A/B/C are detectable — this extension covers A/B/C.
 *
 * **Dual-channel reminder**:
 * 1. `pi.on("agent_settled")` → pin onto the Tasks widget (TUI, user sees)
 * 2. `pi.on("context")` → `injectSyncReminder` (context injection, agent sees next turn)
 *
 * **Pattern**: post-edit extension (tool_result flag + agent_settled debounce)
 * + injectTaskProjection (tasks/index.ts:483 context return { messages }).
 * **Trust surface**: regex detection only; no exec, no auto task mutation.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setTaskWidgetAttachment } from "../shared/task-widget-attachment.ts";

/** A. Bash commands indicating a commit happened. */
const COMMIT_PATTERNS = [/\bgit\s+commit\b/];

/** B. Bash commands indicating verification passed (tsc/test/verify). */
const VERIFY_PATTERNS = [
  /\btsc\b/,
  /\bnpx\s+tsc\b/,
  /\bnpm\s+run\s+verify/,
  /\bnode\s+scripts\/verify/,
  /--test\b/,
  /\bverify:/,
];

/** C. Owner authorization phrases (user message). */
const AUTHORIZATION_PATTERNS = [
  /授权/,
  /同意/,
  /批准/,
  /裁定/,
  /\bapproved\b/i,
  /\bauthorized\b/i,
];

type SignalKind = "commit" | "verify" | "authorization";

/** Signal → Chinese label for the reminder. */
const SIGNAL_LABEL: Record<SignalKind, string> = {
  commit: "commit",
  verify: "验证通过",
  authorization: "业主授权",
};

export default function multiSignalSync(pi: ExtensionAPI) {
  let signals: SignalKind[] = []; // context 注入用（下轮消费）
  let pendingNotify: SignalKind[] = []; // agent_settled Tasks-widget 驻留用（本轮消费）
  let statusShown = false; // footer 驻留状态已显示标记
  let generation = 0;

  /** Add a signal to both channels (dedupe). */
  const addSignal = (kind: SignalKind) => {
    if (!signals.includes(kind)) signals.push(kind);
    if (!pendingNotify.includes(kind)) pendingNotify.push(kind);
  };

  /**
   * A + B: tool_result — hot path, boolean flag only (no await/exec).
   * Detects bash tool success with commit/verify commands.
   */
  pi.on(
    "tool_result",
    (event: {
      toolName: string;
      isError?: boolean;
      input?: unknown;
      params?: unknown;
    }) => {
      if (event.isError) return;
      if (event.toolName !== "bash") return;

      const command = extractCommand(event);
      if (!command) return;

      if (COMMIT_PATTERNS.some((pattern) => pattern.test(command))) {
        addSignal("commit");
      }
      if (VERIFY_PATTERNS.some((pattern) => pattern.test(command))) {
        addSignal("verify");
      }
    },
  );

  /**
   * C + reminder: context — check last user message for authorization phrases,
   * then inject reminder into next turn's messages if any signal detected.
   */
  pi.on("context", (event) => {
    // C: authorization in last user message
    if (lastUserMessageHasAuthorization(event.messages)) {
      addSignal("authorization");
    }

    // Inject reminder if any signal detected (once, then reset)
    if (signals.length === 0) return;
    const detected = signals;
    signals = [];

    const messages = injectSyncReminder(event.messages, detected);
    if (messages) {
      return { messages: messages as typeof event.messages };
    }
  });

  /**
   * Channel 1 — agent_settled: pin the completion reminder onto the Tasks
   * widget (Persistent Status Indicator，跨 render 显示). It renders as the
   * first row under the `◆ Tasks` census header, so the reminder lives where
   * the list it asks to sync is — not in the footer status bar below the
   * input. 下一轮（无新信号）：清除该行。
   */
  pi.on("agent_settled", (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      if (pendingNotify.length > 0) {
        const labels = pendingNotify.map((s) => SIGNAL_LABEL[s]).join(" + ");
        pendingNotify = [];
        setTaskWidgetAttachment(`⚠️ 完成信号（${labels}）— 请同步 tasks`);
        statusShown = true;
      } else if (statusShown) {
        setTaskWidgetAttachment(undefined);
        statusShown = false;
      }
    } catch {
      // Session may have ended; best-effort status update.
    }
  });

  /** Reset on session lifecycle. */
  pi.on("session_start", () => {
    generation++;
    signals = [];
    pendingNotify = [];
    statusShown = false;
    setTaskWidgetAttachment(undefined);
  });

  pi.on("session_shutdown", () => {
    generation++;
    signals = [];
    pendingNotify = [];
    statusShown = false;
    setTaskWidgetAttachment(undefined);
  });
}

/** Build reminder text for the detected signals. */
function buildReminderText(signals: SignalKind[]): string {
  const labels = signals.map((s) => SIGNAL_LABEL[s]).join(" + ");
  return `⚠️ 上轮检测到完成信号（${labels}）。请检查 tasks 状态同步：
- commit/验证通过 → 如有完成项，**立即 tasks_update done** 带 commit SHA + reviewer 结论
- 业主授权 → 如有 blocked task 因授权解除阻塞，同步 status（blocked→done）
- 无变更完成（分析/设计结论）→ 收口时 tasks_update（此类型无信号，靠收口审计纪律）
- 这是 multi-signal-sync hook 自动提醒（MECE：commit/验证/授权 三信号，防 tasks 残留）
注入后自动清除（仅提醒一次/信号）。`;
}

/**
 * Inject reminder into messages (agent-visible next turn).
 * Pattern: injectTaskProjection in tasks/index.ts.
 */
function injectSyncReminder(
  messages: unknown[],
  signals: SignalKind[],
): unknown[] | undefined {
  const next = structuredClone(messages) as Array<{
    role?: string;
    content?: unknown;
  }>;
  const text = buildReminderText(signals);
  for (let index = next.length - 1; index >= 0; index--) {
    const message = next[index];
    if (message.role !== "user") continue;
    const block = {
      type: "text",
      text: `\n\n<multi-signal-sync>\n${text}\n</multi-signal-sync>`,
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
 * Check the last user message for authorization phrases (signal C).
 * Iterates messages from the end; finds the most recent user message.
 */
function lastUserMessageHasAuthorization(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    const text = messageContentText(message.content);
    if (!text) return false; // last user message has no text → no auth signal
    return AUTHORIZATION_PATTERNS.some((pattern) => pattern.test(text));
  }
  return false;
}

/** Flatten message content (string or blocks) to text. */
function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * Extract the bash command string from a tool_result event.
 * Pi's event shape may vary; try common field names.
 */
function extractCommand(event: {
  input?: unknown;
  params?: unknown;
}): string | null {
  const fromInput =
    typeof event.input === "object" && event.input !== null
      ? (event.input as Record<string, unknown>).command
      : undefined;
  if (typeof fromInput === "string") return fromInput;

  const fromParams =
    typeof event.params === "object" && event.params !== null
      ? (event.params as Record<string, unknown>).command
      : undefined;
  if (typeof fromParams === "string") return fromParams;

  if (typeof event.input === "string") return event.input;
  if (typeof event.params === "string") return event.params;

  return null;
}
