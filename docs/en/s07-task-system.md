# s07: Task System

`s01 > s02 > s03 > s04 > s05 > s06 | [ s07 ] s08 > s09 > s10 > s11 > s12`

> *"Break big goals into small tasks, order them, persist to disk"* -- a file-based task graph with dependencies, laying the foundation for multi-agent collaboration.
>
> **Harness layer**: Persistent tasks -- goals that outlive any single conversation.

## Problem

s03's TodoManager is a flat checklist in memory: no ordering, no dependencies, no status beyond done-or-not. Real goals have structure -- task B depends on task A, tasks C and D can run in parallel, task E waits for both C and D.

Without explicit relationships, the agent can't tell what's ready, what's blocked, or what can run concurrently. And because the list lives only in memory, context compression (s06) wipes it clean.

## Solution

Promote the checklist into a **task graph** persisted to disk. Each task is a JSON file with status, dependencies (`blockedBy`), and dependents (`blocks`). The graph answers three questions at any moment:

- **What's ready?** -- tasks with `pending` status and empty `blockedBy`.
- **What's blocked?** -- tasks waiting on unfinished dependencies.
- **What's done?** -- `completed` tasks, whose completion automatically unblocks dependents.

```
.tasks/
  task_1.json  {"id":1, "status":"completed"}
  task_2.json  {"id":2, "blockedBy":[1], "status":"pending"}
  task_3.json  {"id":3, "blockedBy":[1], "status":"pending"}
  task_4.json  {"id":4, "blockedBy":[2,3], "status":"pending"}

Task graph (DAG):
                 +----------+
            +--> | task 2   | --+
            |    | pending  |   |
+----------+     +----------+    +--> +----------+
| task 1   |                          | task 4   |
| completed| --> +----------+    +--> | blocked  |
+----------+     | task 3   | --+     +----------+
                 | pending  |
                 +----------+

Ordering:     task 1 must finish before 2 and 3
Parallelism:  tasks 2 and 3 can run at the same time
Dependencies: task 4 waits for both 2 and 3
Status:       pending -> in_progress -> completed
```

This task graph becomes the coordination backbone for everything after s07: background execution (s08), multi-agent teams (s09+), and worktree isolation (s12) all read from and write to this same structure.

## How It Works

1. **TaskManager**: one JSON file per task, CRUD with dependency graph.

```typescript
interface Task {
  id: number; subject: string; description: string;
  status: string; blockedBy: number[]; blocks: number[]; owner: string;
}

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  create(subject: string, description = ""): string {
    const task: Task = {
      id: this.nextId, subject, description,
      status: "pending", blockedBy: [], blocks: [], owner: "",
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }
}
```

2. **Dependency resolution**: completing a task clears its ID from every other task's `blockedBy` list, automatically unblocking dependents.

```typescript
private clearDependency(completedId: number): void {
  const files = readdirSync(this.dir).filter((f) => f.match(/^task_\d+\.json$/));
  for (const f of files) {
    const task: Task = JSON.parse(readFileSync(join(this.dir, f), "utf-8"));
    if (task.blockedBy.includes(completedId)) {
      task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
      this.save(task);
    }
  }
}
```

3. **Status + dependency wiring**: `update` handles transitions and dependency edges.

```typescript
update(taskId: number, status?: string,
       addBlockedBy?: number[], addBlocks?: number[]): string {
  const task = this.load(taskId);
  if (status) {
    task.status = status;
    if (status === "completed") this.clearDependency(taskId);
  }
  this.save(task);
  return JSON.stringify(task, null, 2);
}
```

4. Four task tools go into the dispatch map.

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ...base tools...
  task_create: (input) => TASKS.create(input.subject as string),
  task_update: (input) => TASKS.update(input.task_id as number, input.status as string),
  task_list:   () => TASKS.listAll(),
  task_get:    (input) => TASKS.get(input.task_id as number),
};
```

From s07 onward, the task graph is the default for multi-step work. s03's Todo remains for quick single-session checklists.

## What Changed From s06

| Component | Before (s06) | After (s07) |
|---|---|---|
| Tools | 5 | 8 (`task_create/update/list/get`) |
| Planning model | Flat checklist (in-memory) | Task graph with dependencies (on disk) |
| Relationships | None | `blockedBy` + `blocks` edges |
| Status tracking | Done or not | `pending` -> `in_progress` -> `completed` |
| Persistence | Lost on compression | Survives compression and restarts |

## Try It

```sh
cd learn-claude-code-ts
bun run agents/s07_task_system.ts
```

1. `Create 3 tasks: "Setup project", "Write code", "Write tests". Make them depend on each other in order.`
2. `List all tasks and show the dependency graph`
3. `Complete task 1 and then list tasks to see task 2 unblocked`
4. `Create a task board for refactoring: parse -> transform -> emit -> test, where transform and emit can run in parallel after parse`
