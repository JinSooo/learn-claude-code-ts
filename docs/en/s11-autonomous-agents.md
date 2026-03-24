# s11: Autonomous Agents

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > [ s11 ] s12`

> *"Teammates scan the board and claim tasks themselves"* -- no need for the lead to assign each one.
>
> **Harness layer**: Autonomy -- models that find work without being told.

## Problem

In s09-s10, teammates only work when explicitly told to. The lead must spawn each one with a specific prompt. 10 unclaimed tasks on the board? The lead assigns each one manually. Doesn't scale.

True autonomy: teammates scan the task board themselves, claim unclaimed tasks, work on them, then look for more.

One subtlety: after context compression (s06), the agent might forget who it is. Identity re-injection fixes this.

## Solution

```
Teammate lifecycle with idle cycle:

+-------+
| spawn |
+---+---+
    |
    v
+-------+   tool_use     +-------+
| WORK  | <------------- |  LLM  |
+---+---+                +-------+
    |
    | stop_reason != tool_use (or idle tool called)
    v
+--------+
|  IDLE  |  poll every 5s for up to 60s
+---+----+
    |
    +---> check inbox --> message? ----------> WORK
    |
    +---> scan .tasks/ --> unclaimed? -------> claim -> WORK
    |
    +---> 60s timeout ----------------------> SHUTDOWN

Identity re-injection after compression:
  if (messages.length <= 3) {
    messages.unshift(identityBlock);
  }
```

## How It Works

1. The teammate loop has two phases: WORK and IDLE. When the LLM stops calling tools (or calls `idle`), the teammate enters IDLE.

```typescript
async _loop(name: string, role: string, prompt: string): Promise<void> {
  while (true) {
    // -- WORK PHASE --
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: prompt },
    ];
    for (let i = 0; i < 50; i++) {
      const response = await client.messages.create(/* ... */);
      if (response.stop_reason !== "tool_use") break;
      // execute tools...
      if (idleRequested) break;
    }

    // -- IDLE PHASE --
    this._setStatus(name, "idle");
    const resume = await this._idlePoll(name, messages);
    if (!resume) {
      this._setStatus(name, "shutdown");
      return;
    }
    this._setStatus(name, "working");
  }
}
```

2. The idle phase polls inbox and task board in a loop.

```typescript
async _idlePoll(name: string, messages: Anthropic.Messages.MessageParam[]): Promise<boolean> {
  const polls = Math.floor(IDLE_TIMEOUT / POLL_INTERVAL);  // 60s / 5s = 12
  for (let p = 0; p < polls; p++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));

    const inbox = BUS.readInbox(name);
    if (inbox.length > 0) {
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }
      return true;
    }

    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length > 0) {
      claimTask(unclaimed[0].id, name);
      messages.push({
        role: "user",
        content: `<auto-claimed>Task #${unclaimed[0].id}: ${unclaimed[0].subject}</auto-claimed>`,
      });
      return true;
    }
  }
  return false;  // timeout -> shutdown
}
```

3. Task board scanning: find pending, unowned, unblocked tasks.

```typescript
function scanUnclaimedTasks(): TaskFile[] {
  const unclaimed: TaskFile[] = [];
  const files = readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .sort();
  for (const f of files) {
    const task: TaskFile = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8"));
    if (task.status === "pending"
        && !task.owner
        && (!task.blockedBy || task.blockedBy.length === 0)) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}
```

4. Identity re-injection: when context is too short (compression happened), insert an identity block.

```typescript
if (messages.length <= 3) {
  messages.unshift({
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, ` +
             `team: ${teamName}. Continue your work.</identity>`,
  });
  messages.splice(1, 0, {
    role: "assistant",
    content: `I am ${name}. Continuing.`,
  });
}
```

## What Changed From s10

| Component      | Before (s10)     | After (s11)                |
|----------------|------------------|----------------------------|
| Tools          | 12               | 14 (+idle, +claim_task)    |
| Autonomy       | Lead-directed    | Self-organizing            |
| Idle phase     | None             | Poll inbox + task board    |
| Task claiming  | Manual only      | Auto-claim unclaimed tasks |
| Identity       | System prompt    | + re-injection after compress|
| Timeout        | None             | 60s idle -> auto shutdown  |

## Try It

```sh
cd learn-claude-code-ts
bun run agents/s11_autonomous_agents.ts
```

1. `Create 3 tasks on the board, then spawn alice and bob. Watch them auto-claim.`
2. `Spawn a coder teammate and let it find work from the task board itself`
3. `Create tasks with dependencies. Watch teammates respect the blocked order.`
4. Type `/tasks` to see the task board with owners
5. Type `/team` to monitor who is working vs idle
