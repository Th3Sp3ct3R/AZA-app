// TodoWrite — task planning + progress tracking.
//
// Per Claude Code spec: each todo has content (imperative form,
// "Run tests") + activeForm (present continuous, "Running tests").
// The UI shows activeForm during in_progress state, content otherwise.
//
// Tool-shape rules the model is drilled on in the system prompt:
//   - Use for any task with 3+ distinct steps
//   - Exactly ONE task in_progress at a time
//   - Mark in_progress BEFORE starting, completed IMMEDIATELY after
//   - Never mark completed if tests fail or work is partial
//
// State is per-session (in-memory). Persisted to the rollout JSONL
// via the todo_updated TurnEvent the engine emits when the tool runs.

import { z } from "zod";
import type { Todo, TodoStatus } from "@ares/protocol";
import { buildTool } from "./_shared.js";

const todoItemSchema = z.object({
  id: z
    .string()
    .min(1)
    .optional()
    .describe("Optional stable id for this todo, reused across updates. Host-derived from position when omitted."),
  content: z
    .string()
    .min(1)
    .describe("Imperative form of the task. Example: \"Run tests\"."),
  activeForm: z
    .string()
    .min(1)
    .describe("Present-continuous form shown during in_progress. Example: \"Running tests\"."),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current state. Exactly one task should be in_progress at any time."),
});

const inputSchema = z
  .object({
    todos: z
      .array(todoItemSchema)
      .min(1)
      .describe("The full updated todo list (replaces the previous list)."),
  })
  .strict();

export interface TodoWriteOutput {
  todos: Todo[];
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  /** Warning emitted when more than one task is in_progress simultaneously. */
  warning?: string;
}

/**
 * Per-session in-memory todo store. The CLI/TUI/Session keeps a
 * reference; the TodoWrite tool writes into it. UI subscribes for
 * rendering.
 */
export class TodoStore {
  private todos: Todo[] = [];

  list(): readonly Todo[] {
    return this.todos;
  }

  replace(next: Todo[]): void {
    this.todos = next;
  }

  inProgress(): Todo | undefined {
    return this.todos.find((t) => t.status === "in_progress");
  }

  countBy(status: TodoStatus): number {
    return this.todos.filter((t) => t.status === status).length;
  }
}

/**
 * Build the TodoWrite tool bound to a specific store. The store lives
 * in the CLI/Session layer so multiple Tool instances (e.g. when reusing
 * across turns) share the same list.
 */
export function makeTodoWriteTool(store: TodoStore) {
  return buildTool({
    name: "TodoWrite",
    description:
      "Create or update the structured task list for this session. Pass the COMPLETE list each time — it replaces the previous list. Use proactively for any task with 3+ steps; mark exactly one task as in_progress at a time; mark items completed IMMEDIATELY after finishing (don't batch completions). " +
      "COMPLETION GATE: only mark a task 'completed' when it is FULLY done and verified — never while tests are failing, the implementation is partial, or errors are unresolved. If you hit a blocker, keep the task in_progress and add a new task describing what must be resolved. A green checkmark you didn't earn is a lie to the user.",
    safety: "read-only",
    concurrency: "parallel-safe",
    inputZod: inputSchema,
    activityDescription: (i) => `Tracking ${i.todos.length} todo${i.todos.length === 1 ? "" : "s"}`,
    async call(i, ctx): Promise<{ output: TodoWriteOutput; display: string }> {
      // The canonical Claude TodoWrite shape is {content, status, activeForm}
      // with no id, so honor a model-supplied id but derive a stable one from
      // the item's position when omitted (don't hard-reject the common call).
      const todos: Todo[] = i.todos.map((t, idx) => ({
        id: t.id ?? `todo-${idx}`,
        content: t.content,
        activeForm: t.activeForm,
        status: t.status,
      }));

      // Hosts such as Garrison reuse one immutable tool catalog across many
      // sessions. Prefer the context-routed store so one session's checklist
      // cannot overwrite another's; keep the captured store for CLI callers
      // that intentionally bind a tool instance to one session.
      (ctx.todoStore ?? store).replace(todos);

      const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
      const pendingCount = todos.filter((t) => t.status === "pending").length;
      const completedCount = todos.filter((t) => t.status === "completed").length;

      const warning =
        inProgressCount > 1
          ? `Warning: ${inProgressCount} todos are in_progress simultaneously. Only one should be in_progress at a time.`
          : undefined;

      const active = todos.find((t) => t.status === "in_progress");
      const display = active
        ? `▶ ${active.activeForm} (${completedCount}/${todos.length})`
        : `${completedCount}/${todos.length} todos complete`;

      return {
        output: { todos, pendingCount, inProgressCount, completedCount, warning },
        display,
      };
    },
  });
}
