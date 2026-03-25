# s03: TodoWrite

`s01 > s02 > [ s03 ] s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"計画のないエージェントは行き当たりばったり"* -- まずステップを書き出し、それから実行。
>
> **Harness 層**: 計画 -- 航路を描かずにモデルを軌道に乗せる。

## 問題

マルチステップのタスクで、モデルは途中で迷子になる。作業を繰り返したり、ステップを飛ばしたり、脱線したりする。長い会話になるほど悪化する -- ツール結果がコンテキストを埋めるにつれ、システムプロンプトの影響力が薄れる。10ステップのリファクタリングでステップ1-3を完了した後、残りを忘れて即興を始めてしまう。

## 解決策

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

## 仕組み

1. TodoManagerはアイテムのリストをステータス付きで保持する。`in_progress`にできるのは同時に1つだけ。

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

2. `todo`ツールは他のツールと同様にディスパッチマップに追加される。

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ...base tools...
  todo: (input) => TODO.update(input.items as unknown[]),
};
```

3. nagリマインダーが、モデルが3ラウンド以上`todo`を呼ばなかった場合にナッジを注入する。

```typescript
roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
if (roundsSinceTodo >= 3) {
  results.unshift({
    type: "text",
    text: "<reminder>Update your todos.</reminder>",
  });
}
```

「一度にin_progressは1つだけ」の制約が逐次的な集中を強制し、nagリマインダーが説明責任を生む。

## s02からの変更点

| Component      | Before (s02)     | After (s03)                |
|----------------|------------------|----------------------------|
| Tools          | 4                | 5 (+todo)                  |
| Planning       | None             | TodoManager with statuses  |
| Nag injection  | None             | `<reminder>` after 3 rounds|
| Agent loop     | Simple dispatch  | + roundsSinceTodo counter  |

## 試してみる

```sh
cd learn-claude-code-ts
bun run agents/s03_todo_write.ts
```

1. `Refactor the file hello.ts: add type annotations, JSDoc comments, and a main guard`
2. `Create a TypeScript package with index.ts, utils.ts, and tests/test_utils.ts`
3. `Review all TypeScript files and fix any style issues`
