# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"Run slow operations in the background; the agent keeps thinking"* -- async callbacks run commands, inject notifications on completion.
>
> **Harness layer**: Background execution -- the model thinks while the harness waits.

## Problem

Some commands take minutes: `npm install`, `vitest`, `docker build`. With a blocking loop, the model sits idle waiting. If the user asks "install dependencies and while that runs, create the config file," the agent does them sequentially, not in parallel.

## Solution

```
Main thread                Background (async)
+-----------------+        +-----------------+
| agent loop      |        | child process   |
| ...             |        | ...             |
| [LLM call] <---+------- | push(result)    |
|  ^drain queue   |        +-----------------+
+-----------------+

Timeline:
Agent --[spawn A]--[spawn B]--[other work]----
             |          |
             v          v
          [A runs]   [B runs]      (parallel)
             |          |
             +-- results injected before next LLM call --+
```

## How It Works

1. BackgroundManager tracks tasks with a notification queue.

```typescript
interface BgTask { status: string; result: string | null; command: string }
interface BgNotification { task_id: string; status: string; command: string; result: string }

class BackgroundManager {
  tasks: Record<string, BgTask> = {};
  private notifications: BgNotification[] = [];
}
```

2. `run()` starts a child process via `exec()` and returns immediately.

```typescript
run(command: string): string {
  const taskId = randomUUID().slice(0, 8);
  this.tasks[taskId] = { status: "running", result: null, command };
  exec(command, { cwd: WORKDIR, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
    (err, stdout, stderr) => {
      let output: string; let status: string;
      if (err && err.killed) { output = "Error: Timeout (300s)"; status = "timeout"; }
      else if (err) { output = ((stdout ?? "") + (stderr ?? "")).trim(); status = "error"; }
      else { output = ((stdout ?? "") + (stderr ?? "")).trim(); status = "completed"; }
      this.tasks[taskId] = { status, result: output, command };
      this.notifications.push({
        task_id: taskId, status, command: command.slice(0, 80), result: output.slice(0, 500),
      });
    });
  return `Background task ${taskId} started`;
}
```

3. When the child process finishes, its result goes into the notification queue.

4. The agent loop drains notifications before each LLM call.

```typescript
async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  while (true) {
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs
        .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    const response = await client.messages.create(/* ... */);
    // ...
  }
}
```

The loop stays single-threaded. Only subprocess I/O is parallelized via Node's `exec()` callback.

## What Changed From s07

| Component      | Before (s07)     | After (s08)                    |
|----------------|------------------|--------------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + async child processes |
| Notification   | None             | Queue drained per loop         |
| Concurrency    | None             | Node.js `exec()` callbacks     |

## Try It

```sh
cd learn-claude-code-ts
bun run agents/s08_background_tasks.ts
```

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run vitest in the background and keep working on other things`
