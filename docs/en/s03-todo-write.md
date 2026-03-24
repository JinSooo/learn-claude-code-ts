# s03: TodoWrite

`s01 > s02 > [ s03 ] s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"An agent without a plan drifts"* -- list the steps first, then execute.
>
> **Harness layer**: Planning -- keeping the model on course without scripting the route.

## Problem

On multi-step tasks, the model loses track. It repeats work, skips steps, or wanders off. Long conversations make this worse -- the system prompt fades as tool results fill the context. A 10-step refactoring might complete steps 1-3, then the model starts improvising because it forgot steps 4-10.

## Solution

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> | Tools   |
| prompt |      |       |      | + todo  |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                          |
              +-----------+-----------+
              | TodoManager state     |
              | [ ] task A            |
              | [>] task B  <- doing  |
              | [x] task C            |
              +-----------------------+
                          |
              if rounds_since_todo >= 3:
                inject <reminder> into tool_result
```

## How It Works

1. TodoManager stores items with statuses. Only one item can be `in_progress` at a time.

```typescript
class TodoManager {
  items: TodoItem[] = [];

  update(items: unknown[]): string {
    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (const item of items) {
      const { id, text, status } = item as Record<string, unknown>;
      if (status === "in_progress") inProgressCount++;
      validated.push({
        id: String(id),
        text: String(text),
        status: status as TodoItem["status"],
      });
    }
    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }
    this.items = validated;
    return this.render();
  }
}
```

2. The `todo` tool goes into the dispatch map like any other tool.

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ...base tools...
  todo: (input) => TODO.update(input.items as unknown[]),
};
```

3. A nag reminder injects a nudge if the model goes 3+ rounds without calling `todo`.

```typescript
roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
if (roundsSinceTodo >= 3) {
  results.unshift({
    type: "text",
    text: "<reminder>Update your todos.</reminder>",
  });
}
```

The "one in_progress at a time" constraint forces sequential focus. The nag reminder creates accountability.

## What Changed From s02

| Component      | Before (s02)     | After (s03)                |
|----------------|------------------|----------------------------|
| Tools          | 4                | 5 (+todo)                  |
| Planning       | None             | TodoManager with statuses  |
| Nag injection  | None             | `<reminder>` after 3 rounds|
| Agent loop     | Simple dispatch  | + roundsSinceTodo counter  |

## Try It

```sh
cd learn-claude-code-ts
bun run agents/s03_todo_write.ts
```

1. `Refactor the file hello.ts: add type annotations, JSDoc comments, and a main guard`
2. `Create a TypeScript package with index.ts, utils.ts, and tests/test_utils.ts`
3. `Review all TypeScript files and fix any style issues`
