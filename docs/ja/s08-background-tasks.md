# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"遅い操作はバックグラウンドへ、エージェントは次を考え続ける"* -- 非同期コールバックがコマンド実行、完了後に通知を注入。
>
> **Harness 層**: バックグラウンド実行 -- モデルが考え続ける間、Harness が待つ。

## 問題

一部のコマンドは数分かかる: `npm install`、`vitest`、`docker build`。ブロッキングループでは、モデルはサブプロセスの完了を待って座っている。ユーザーが「依存関係をインストールして、その間にconfigファイルを作って」と言っても、エージェントは並列ではなく逐次的に処理する。

## 解決策

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

## 仕組み

1. BackgroundManagerが通知キューでタスクを追跡する。

```typescript
interface BgTask { status: string; result: string | null; command: string }
interface BgNotification { task_id: string; status: string; command: string; result: string }

class BackgroundManager {
  tasks: Record<string, BgTask> = {};
  private notifications: BgNotification[] = [];
}
```

2. `run()`が`exec()`で子プロセスを開始し、即座にリターンする。

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

3. 子プロセス完了時に、結果を通知キューへ。

4. エージェントループが各LLM呼び出しの前に通知をドレインする。

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

ループはシングルスレッドのまま。サブプロセスI/OだけがNode.jsの`exec()`コールバックで並列化される。

## s07からの変更点

| Component      | Before (s07)     | After (s08)                    |
|----------------|------------------|--------------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + async child processes |
| Notification   | None             | Queue drained per loop         |
| Concurrency    | None             | Node.js `exec()` callbacks     |

## 試してみる

```sh
cd learn-claude-code-ts
bun run agents/s08_background_tasks.ts
```

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run vitest in the background and keep working on other things`
