export const TASKS_ENTRY_TYPE = "session-tasks";
export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "dropped",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskItem {
  id: number;
  subject: string;
  detail?: string;
  status: TaskStatus;
  note?: string;
}

export interface TaskSnapshot {
  version: 1;
  revision: number;
  nextId: number;
  items: TaskItem[];
}

export interface TaskAddInput {
  subject: string;
  detail?: string;
  status?: TaskStatus;
  note?: string;
}

export interface TaskUpdateInput {
  id: number;
  subject?: string;
  detail?: string | null;
  status?: TaskStatus;
  note?: string | null;
}

export interface TaskFilter {
  id?: number;
  status?: TaskStatus;
}

export interface TaskMutation {
  snapshot: TaskSnapshot;
  items: TaskItem[];
}

export const TASKS_LIMITS = Object.freeze({
  subjectChars: 120,
  detailChars: 500,
  noteChars: 500,
  items: 100,
  addBatch: 20,
  snapshotBytes: 16_384,
  projectionChars: 800,
  renderedListChars: 16_384,
});

const REQUIRED_NOTE_STATUSES = new Set<TaskStatus>([
  "blocked",
  "done",
  "dropped",
]);

/**
 * Order used when a single "next actionable task" must be picked (omp's
 * `nextActionableTask`): the item in flight wins, then the oldest open one.
 * Blocked items are waiting on something external — not actionable by the
 * agent — so they are deliberately excluded.
 */
const ACTIONABLE_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  blocked: 2,
  done: 3,
  dropped: 4,
};

/** The next task an agent should be working on, or undefined when none. */
export function nextActionableTask(
  items: readonly TaskItem[],
): TaskItem | undefined {
  const actionable = items
    .filter(
      (item) => item.status === "pending" || item.status === "in_progress",
    )
    .sort(
      (left, right) =>
        ACTIONABLE_ORDER[left.status] - ACTIONABLE_ORDER[right.status] ||
        left.id - right.id,
    );
  return actionable[0];
}

/**
 * Fold a subject/description down to a stable match key (omp's
 * `normalizeForTodoMatch`, plus space removal): lowercase, then every run of
 * non-letter/non-digit characters — punctuation AND whitespace — is dropped,
 * so "切片2：四端关卡" and "切片 2 四端关卡" reconcile (CJK text often
 * spaces digits differently), and "Sonnet #2" matches "sonnet 2".
 */
export function normalizeForTaskMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** omp's substring-fallback floor for todo↔description matching. */
const TASK_MATCH_MIN_OVERLAP = 6;

/**
 * Whether a subagent description matches a task subject well enough to
 * auto-close it (omp's `todoMatchesAnyDescription`): normalize-then-equal
 * first, then a substring fallback in either direction with a length floor,
 * so minor wording drift still links up.
 */
export function taskMatchesDescription(
  subject: string,
  description: string,
): boolean {
  const a = normalizeForTaskMatch(subject);
  const b = normalizeForTaskMatch(description);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= TASK_MATCH_MIN_OVERLAP && b.includes(a)) return true;
  if (b.length >= TASK_MATCH_MIN_OVERLAP && a.includes(b)) return true;
  return false;
}

/**
 * Single in-progress invariant (omp's `normalizeInProgressTask`): marking one
 * item in_progress demotes any other in-progress item back to pending. The
 * HUD and projections both read better when exactly one thing is in flight.
 */
export function normalizeSingleInProgress(
  items: readonly TaskItem[],
  inProgressId: number,
): TaskItem[] {
  return items.map((item) =>
    item.id !== inProgressId && item.status === "in_progress"
      ? { ...item, status: "pending" as const }
      : item,
  );
}
const SNAPSHOT_KEYS = new Set(["version", "revision", "nextId", "items"]);
const ITEM_KEYS = new Set(["id", "subject", "detail", "status", "note"]);
const ADD_KEYS = new Set(["subject", "detail", "status", "note"]);
const UPDATE_KEYS = new Set(["id", "subject", "detail", "status", "note"]);
const PROJECTION_HEADER =
  "Session tasks: advisory context, not an instruction to resume unrelated work. " +
  "Real files, git, tests, tools, artifacts, and user confirmation are truth. " +
  "Use tasks_list for details. After compaction/pivot, coordinate with these tasks instead of recreating items.";

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationError";
  }
}

export class TaskRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRestoreError";
  }
}

export interface SessionTasks {
  add(input: TaskAddInput | readonly TaskAddInput[]): TaskMutation;
  update(input: TaskUpdateInput): TaskMutation;
  list(filter?: TaskFilter): TaskItem[];
  snapshot(): TaskSnapshot;
  project(): string;
  render(filter?: TaskFilter, maxChars?: number): string;
  commit(snapshot: TaskSnapshot): void;
}

export function emptyTaskSnapshot(): TaskSnapshot {
  return { version: 1, revision: 0, nextId: 1, items: [] };
}

export function validateTaskSnapshot(value: unknown): TaskSnapshot {
  if (!isRecord(value)) fail("snapshot must be an object");
  assertExactKeys(value, SNAPSHOT_KEYS, "snapshot");
  if (value.version !== 1)
    fail(`unsupported snapshot version: ${String(value.version)}`);
  assertNonNegativeInteger(value.revision, "snapshot.revision");
  assertPositiveInteger(value.nextId, "snapshot.nextId");
  if (!Array.isArray(value.items)) fail("snapshot.items must be an array");
  if (value.items.length > TASKS_LIMITS.items) {
    fail(`snapshot.items exceeds ${TASKS_LIMITS.items}`);
  }

  const ids = new Set<number>();
  const items = value.items.map((item, index) => {
    const checked = validateItem(item, `snapshot.items[${index}]`);
    if (ids.has(checked.id)) fail(`duplicate task id: ${checked.id}`);
    ids.add(checked.id);
    return checked;
  });
  const nextId = value.nextId as number;
  if (items.some((item) => item.id >= nextId)) {
    fail("snapshot.nextId must be greater than every item id");
  }
  const snapshot: TaskSnapshot = {
    version: 1,
    revision: value.revision as number,
    nextId,
    items,
  };
  assertSnapshotBytes(snapshot);
  return snapshot;
}

export function applyTaskAdd(
  current: TaskSnapshot,
  additions: readonly TaskAddInput[],
): TaskMutation {
  const base = validateTaskSnapshot(current);
  if (additions.length < 1) fail("add requires at least one item");
  if (additions.length > TASKS_LIMITS.addBatch) {
    fail(`add batch exceeds ${TASKS_LIMITS.addBatch}`);
  }
  if (base.items.length + additions.length > TASKS_LIMITS.items) {
    fail(`task list exceeds ${TASKS_LIMITS.items} items`);
  }

  let nextId = base.nextId;
  const added = additions.map((addition, index) => {
    if (!isRecord(addition)) fail(`additions[${index}] must be an object`);
    assertExactKeys(addition, ADD_KEYS, `additions[${index}]`);
    assertPositiveInteger(nextId, "allocated id");
    const item = validateItem(
      {
        id: nextId,
        subject: addition.subject,
        ...(hasOwn(addition, "detail") ? { detail: addition.detail } : {}),
        status: addition.status ?? "pending",
        ...(hasOwn(addition, "note") ? { note: addition.note } : {}),
      },
      `additions[${index}]`,
    );
    nextId += 1;
    return item;
  });

  const candidate = closeCompletedTaskBatch(
    validateTaskSnapshot({
      version: 1,
      revision: increment(base.revision, "snapshot revision"),
      nextId,
      items: [...base.items, ...added],
    }),
  );
  return { snapshot: candidate, items: cloneItems(added) };
}

export function applyTaskUpdate(
  current: TaskSnapshot,
  update: TaskUpdateInput,
): TaskMutation {
  const base = validateTaskSnapshot(current);
  if (!isRecord(update)) fail("update must be an object");
  assertExactKeys(update, UPDATE_KEYS, "update");
  assertPositiveInteger(update.id, "update.id");
  if (Object.keys(update).length === 1)
    fail("update must change at least one field");

  const index = base.items.findIndex((item) => item.id === update.id);
  if (index < 0) fail(`task item T${update.id} does not exist`);
  const previous = base.items[index];
  const status = hasOwn(update, "status")
    ? validateStatus(update.status, "update.status")
    : previous.status;
  const statusChanged = status !== previous.status;
  const entersRequiredNote =
    statusChanged && REQUIRED_NOTE_STATUSES.has(status);

  if (entersRequiredNote && !hasOwn(update, "note")) {
    fail(`a fresh note is required when status changes to ${status}`);
  }

  let note = previous.note;
  if (statusChanged && REQUIRED_NOTE_STATUSES.has(previous.status))
    note = undefined;
  if (hasOwn(update, "note")) note = update.note ?? undefined;

  const changed = validateItem(
    {
      id: previous.id,
      subject: hasOwn(update, "subject") ? update.subject : previous.subject,
      ...(hasOwn(update, "detail")
        ? update.detail === null
          ? {}
          : { detail: update.detail }
        : previous.detail === undefined
          ? {}
          : { detail: previous.detail }),
      status,
      ...(note === undefined ? {} : { note }),
    },
    "updated item",
  );
  if (
    changed.subject === previous.subject &&
    changed.detail === previous.detail &&
    changed.status === previous.status &&
    changed.note === previous.note
  ) {
    return { snapshot: base, items: cloneItems([previous]) };
  }

  const items = base.items.slice();
  items[index] = changed;
  // Single in-progress invariant (omp's normalizeInProgressTask): starting
  // this item demotes any other in-flight item back to pending.
  const normalized =
    status === "in_progress"
      ? normalizeSingleInProgress(items, changed.id)
      : items;
  const candidate = closeCompletedTaskBatch(
    validateTaskSnapshot({
      version: 1,
      revision: increment(base.revision, "snapshot revision"),
      nextId: base.nextId,
      items: normalized,
    }),
  );
  return { snapshot: candidate, items: cloneItems([changed]) };
}

export function restoreTaskSnapshot(entries: readonly unknown[]): TaskSnapshot {
  const candidates = entries.flatMap((entry, position) => {
    const payload = extractTasksPayload(entry);
    return payload.found ? [{ payload: payload.value, position }] : [];
  });
  if (candidates.length === 0) return emptyTaskSnapshot();

  let winner:
    | {
        position: number;
        revision: number;
        snapshot?: TaskSnapshot;
        error?: Error;
      }
    | undefined;
  const unknownVersions: number[] = [];
  const unrankedMalformed: number[] = [];
  const validSnapshots: Array<{
    position: number;
    revision: number;
    snapshot: TaskSnapshot;
  }> = [];

  for (const candidate of candidates) {
    const revision = declaredRevision(candidate.payload);
    const version = declaredVersion(candidate.payload);
    const unknownVersion = version !== undefined && version !== 1;
    if (unknownVersion) unknownVersions.push(candidate.position);

    let snapshot: TaskSnapshot | undefined;
    let error: Error | undefined;
    if (unknownVersion) {
      error = new TaskRestoreError(
        `unsupported snapshot version: ${String(version)}`,
      );
    } else {
      try {
        snapshot = validateTaskSnapshot(candidate.payload);
        if (revision !== undefined) {
          validSnapshots.push({
            position: candidate.position,
            revision,
            snapshot,
          });
        }
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }
    }
    if (revision === undefined) {
      unrankedMalformed.push(candidate.position);
      continue;
    }
    if (
      !winner ||
      revision > winner.revision ||
      (revision === winner.revision && candidate.position > winner.position)
    ) {
      winner = { position: candidate.position, revision, snapshot, error };
    }
  }

  if (!winner) {
    throw new TaskRestoreError("task history contains no restorable snapshot");
  }
  if (
    unknownVersions.some((position) => position > winner.position) ||
    unrankedMalformed.some((position) => position > winner.position)
  ) {
    throw new TaskRestoreError(
      "a later unknown or malformed task entry locks restoration",
    );
  }
  if (!winner.snapshot) {
    throw new TaskRestoreError(
      `winning task revision ${winner.revision} is malformed: ${winner.error?.message ?? "invalid snapshot"}`,
    );
  }

  const current = closeCompletedTaskBatch(winner.snapshot);
  if (isTaskBatchReset(current)) return current;

  const latestClosedBatchRevision = validSnapshots.reduce(
    (latest, candidate) =>
      candidate.revision < winner.revision &&
      (isTaskBatchComplete(candidate.snapshot) ||
        isTaskBatchReset(candidate.snapshot))
        ? Math.max(latest, candidate.revision)
        : latest,
    -1,
  );
  const nextIdHighWater = validSnapshots
    .filter((candidate) => candidate.revision > latestClosedBatchRevision)
    .reduce(
      (highWater, candidate) => Math.max(highWater, candidate.snapshot.nextId),
      1,
    );
  const maxId = current.items.reduce(
    (maximum, item) => Math.max(maximum, item.id),
    0,
  );
  const nextId = Math.max(
    nextIdHighWater,
    current.nextId,
    increment(maxId, "item id"),
  );
  return validateTaskSnapshot({ ...current, nextId });
}

export function projectTasks(snapshot: TaskSnapshot): string {
  const checked = validateTaskSnapshot(snapshot);
  const rank: Record<TaskStatus, number> = {
    in_progress: 0,
    blocked: 1,
    pending: 2,
    done: 3,
    dropped: 4,
  };
  const actionable = checked.items
    .filter((item) => rank[item.status] < 3)
    .sort((left, right) => rank[left.status] - rank[right.status]);
  if (actionable.length === 0) return "";

  let output = PROJECTION_HEADER;
  for (const item of actionable) {
    const line = `\nT${item.id} [${item.status}] ${singleLine(item.subject)}`;
    if (charCount(output + line) > TASKS_LIMITS.projectionChars) break;
    output += line;
  }
  return takeChars(output, TASKS_LIMITS.projectionChars);
}

export function listTaskItems(
  snapshot: TaskSnapshot,
  filter: TaskFilter = {},
): TaskItem[] {
  const checked = validateTaskSnapshot(snapshot);
  validateFilter(filter);
  return cloneItems(
    checked.items.filter(
      (item) =>
        (filter.id === undefined || item.id === filter.id) &&
        (filter.status === undefined || item.status === filter.status),
    ),
  );
}

export function renderTaskList(
  snapshot: TaskSnapshot,
  filter: TaskFilter = {},
  maxChars: number = TASKS_LIMITS.renderedListChars,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    fail("maxChars must be a positive safe integer");
  }
  const bound = Math.min(maxChars, TASKS_LIMITS.renderedListChars);
  const items = listTaskItems(snapshot, filter);
  const text =
    items.length === 0
      ? "No task items."
      : items
          .map((item) => {
            const lines = [
              `T${item.id} [${item.status}] ${singleLine(item.subject)}`,
            ];
            if (item.detail !== undefined)
              lines.push(`  detail: ${singleLine(item.detail)}`);
            if (item.note !== undefined)
              lines.push(`  note: ${singleLine(item.note)}`);
            return lines.join("\n");
          })
          .join("\n");
  return takeChars(text, bound);
}

export function createSessionTasks(
  initial: TaskSnapshot = emptyTaskSnapshot(),
): SessionTasks {
  let current = cloneSnapshot(validateTaskSnapshot(initial));
  return {
    add(input) {
      const additions = Array.isArray(input) ? input : [input];
      return cloneMutation(applyTaskAdd(current, additions));
    },
    update(input) {
      return cloneMutation(applyTaskUpdate(current, input));
    },
    list(filter) {
      return listTaskItems(current, filter);
    },
    snapshot() {
      return cloneSnapshot(current);
    },
    project() {
      return projectTasks(current);
    },
    render(filter, maxChars) {
      return renderTaskList(current, filter, maxChars);
    },
    commit(snapshot) {
      current = cloneSnapshot(validateTaskSnapshot(snapshot));
    },
  };
}

/** omp's checklist markers, reused verbatim for export/import fidelity. */
const STATUS_MARKER: Record<TaskStatus, string> = {
  pending: " ",
  in_progress: "/",
  blocked: "!",
  done: "x",
  dropped: "-",
};

const MARKER_STATUS: Record<string, TaskStatus> = {
  " ": "pending",
  "": "pending",
  x: "done",
  X: "done",
  "/": "in_progress",
  ">": "in_progress",
  "!": "blocked",
  "-": "dropped",
  "~": "dropped",
};

/**
 * Render the batch as an editable Markdown checklist (omp's
 * `phasesToMarkdown`): one line per task, marker in `[ ]`, done items as
 * `[x]`. Notes ride in a trailing ` -- note` suffix so a hand-edited file
 * still round-trips.
 */
export function tasksToMarkdown(snapshot: TaskSnapshot): string {
  if (snapshot.items.length === 0) return "# Tasks\n";
  const lines = snapshot.items.map((item) => {
    const note = item.note ? ` -- ${singleLine(item.note)}` : "";
    return `- [${STATUS_MARKER[item.status]}] ${singleLine(item.subject)}${note}`;
  });
  return `# Tasks\n\n${lines.join("\n")}\n`;
}

/**
 * Parse an edited checklist back into task items (omp's `markdownToPhases`).
 * The imported list replaces the batch wholesale; ids are reassigned in file
 * order and the `-- note` suffix is recovered when present.
 */
export function markdownToTasks(markdown: string): {
  items: TaskAddInput[];
  errors: string[];
} {
  const items: TaskAddInput[] = [];
  const errors: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let inList = false;
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const raw = lines[lineNumber]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s+/.test(trimmed)) {
      inList = true;
      continue;
    }
    const match = /^[-*+]\s*\[(.?)\]\s+(.+?)\s*$/.exec(trimmed);
    if (!match) {
      if (inList)
        errors.push(`Line ${lineNumber + 1}: unrecognized syntax "${trimmed}"`);
      continue;
    }
    const status = MARKER_STATUS[match[1]!];
    if (!status) {
      errors.push(
        `Line ${lineNumber + 1}: unknown status marker "[${match[1]}]" (use [ ], [/], [x], [!], [-])`,
      );
      continue;
    }
    const rawContent = match[2]!.trim();
    const noteMatch = /^(.*?)\s+--\s+(.*)$/.exec(rawContent);
    const subject = noteMatch ? noteMatch[1]!.trim() : rawContent;
    items.push({
      subject: takeChars(subject, TASKS_LIMITS.subjectChars),
      ...(noteMatch
        ? { note: takeChars(noteMatch[2]!.trim(), TASKS_LIMITS.noteChars) }
        : {}),
      ...(status === "pending" ? {} : { status }),
    });
  }
  return { items, errors };
}

export function isTaskBatchComplete(snapshot: TaskSnapshot) {
  const checked = validateTaskSnapshot(snapshot);
  return (
    checked.items.length > 0 &&
    checked.items.every(
      (item) => item.status === "done" || item.status === "dropped",
    )
  );
}

function closeCompletedTaskBatch(snapshot: TaskSnapshot) {
  const checked = validateTaskSnapshot(snapshot);
  if (!isTaskBatchComplete(checked)) return checked;
  return validateTaskSnapshot({ ...checked, nextId: 1, items: [] });
}

function isTaskBatchReset(snapshot: TaskSnapshot) {
  return snapshot.items.length === 0 && snapshot.nextId === 1;
}

function validateItem(value: unknown, path: string): TaskItem {
  if (!isRecord(value)) fail(`${path} must be an object`);
  assertExactKeys(value, ITEM_KEYS, path);
  assertPositiveInteger(value.id, `${path}.id`);
  const subject = normalizeText(
    value.subject,
    `${path}.subject`,
    TASKS_LIMITS.subjectChars,
    true,
  );
  const status = validateStatus(value.status, `${path}.status`);
  const detail = hasOwn(value, "detail")
    ? normalizeText(
        value.detail,
        `${path}.detail`,
        TASKS_LIMITS.detailChars,
        false,
      )
    : undefined;
  const note = hasOwn(value, "note")
    ? normalizeText(value.note, `${path}.note`, TASKS_LIMITS.noteChars, true)
    : undefined;
  if (REQUIRED_NOTE_STATUSES.has(status) && note === undefined) {
    fail(`${path}.note is required for ${status}`);
  }
  return {
    id: value.id as number,
    subject,
    ...(detail !== undefined ? { detail } : {}),
    status,
    ...(note !== undefined ? { note } : {}),
  };
}

function validateStatus(value: unknown, path: string): TaskStatus {
  if (!TASK_STATUSES.includes(value as TaskStatus)) {
    fail(`${path} must be a valid task status`);
  }
  return value as TaskStatus;
}

function validateFilter(filter: TaskFilter) {
  if (!isRecord(filter)) fail("filter must be an object");
  assertExactKeys(filter, new Set(["id", "status"]), "filter");
  if (filter.id !== undefined) assertPositiveInteger(filter.id, "filter.id");
  if (filter.status !== undefined)
    validateStatus(filter.status, "filter.status");
}

function extractTasksPayload(entry: unknown): {
  found: boolean;
  value?: unknown;
} {
  if (
    !isRecord(entry) ||
    entry.type !== "custom" ||
    entry.customType !== TASKS_ENTRY_TYPE
  ) {
    return { found: false };
  }
  return {
    found: true,
    value: hasOwn(entry, "data") ? entry.data : undefined,
  };
}

function declaredRevision(value: unknown) {
  if (!isRecord(value)) return undefined;
  return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    ? (value.revision as number)
    : undefined;
}

function declaredVersion(value: unknown) {
  if (!isRecord(value) || !hasOwn(value, "version")) return undefined;
  return value.version;
}

function assertSnapshotBytes(snapshot: TaskSnapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (bytes > TASKS_LIMITS.snapshotBytes) {
    fail(
      `serialized snapshot exceeds ${TASKS_LIMITS.snapshotBytes} UTF-8 bytes`,
    );
  }
}

function normalizeText(
  value: unknown,
  path: string,
  maxChars: number,
  requireNonBlank: boolean,
) {
  if (typeof value !== "string") fail(`${path} must be a string`);
  const normalized = singleLine(value);
  if (/\p{Cc}/u.test(normalized))
    fail(`${path} must not contain control characters`);
  if (charCount(normalized) > maxChars)
    fail(`${path} exceeds ${maxChars} characters`);
  if (requireNonBlank && normalized.trim().length === 0)
    fail(`${path} must not be blank`);
  return normalized;
}

function assertPositiveInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${path} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${path} must be a non-negative safe integer`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} contains unknown field: ${key}`);
  }
}

function increment(value: number, path: string) {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) fail(`${path} exhausted safe integers`);
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function charCount(value: string) {
  return Array.from(value).length;
}

function takeChars(value: string, maximum: number) {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  if (maximum === 1) return "…";
  return characters.slice(0, maximum - 1).join("") + "…";
}

function singleLine(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function cloneItems(items: readonly TaskItem[]) {
  return items.map((item) => ({ ...item }));
}

function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return { ...snapshot, items: cloneItems(snapshot.items) };
}

function cloneMutation(mutation: TaskMutation): TaskMutation {
  return {
    snapshot: cloneSnapshot(mutation.snapshot),
    items: cloneItems(mutation.items),
  };
}

function fail(message: string): never {
  throw new TaskValidationError(message);
}
