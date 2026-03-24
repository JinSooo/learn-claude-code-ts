# s08: Background Tasks (后台任务)

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"慢操作丢后台, agent 继续想下一步"* -- 异步回调跑命令, 完成后注入通知。
>
> **Harness 层**: 后台执行 -- 模型继续思考, harness 负责等待。

## 问题

有些命令要跑好几分钟: `npm install`、`vitest`、`docker build`。阻塞式循环下模型只能干等。用户说 "装依赖, 顺便建个配置文件", 智能体却只能一个一个来。

## 解决方案

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

## 工作原理

1. BackgroundManager 用通知队列追踪任务。

```typescript
interface BgTask { status: string; result: string | null; command: string }
interface BgNotification { task_id: string; status: string; command: string; result: string }

class BackgroundManager {
  tasks: Record<string, BgTask> = {};
  private notifications: BgNotification[] = [];
}
```

2. `run()` 通过 `exec()` 启动子进程, 立即返回。

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

3. 子进程完成后, 结果进入通知队列。

4. 每次 LLM 调用前排空通知队列。

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

循环保持单线程。只有子进程 I/O 通过 Node.js 的 `exec()` 回调被并行化。

## 相对 s07 的变更

| 组件           | 之前 (s07)       | 之后 (s08)                         |
|----------------|------------------|------------------------------------|
| Tools          | 8                | 6 (基础 + background_run + check)  |
| 执行方式       | 仅阻塞           | 阻塞 + 异步子进程                  |
| 通知机制       | 无               | 每轮排空的队列                     |
| 并发           | 无               | Node.js `exec()` 回调              |

## 试一试

```sh
cd learn-claude-code-ts
bun run agents/s08_background_tasks.ts
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run vitest in the background and keep working on other things`
