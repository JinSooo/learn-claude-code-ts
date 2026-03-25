# s04: Subagents

`s01 > s02 > s03 > [ s04 ] s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"大きなタスクを分割し、各サブタスクにクリーンなコンテキストを"* -- サブエージェントは独立した messages[] を使い、メイン会話を汚さない。
>
> **Harness 層**: コンテキスト隔離 -- モデルの思考の明晰さを守る。

## 問題

エージェントが作業するにつれ、messages配列は膨張し続ける。すべてのファイル読み取り、すべてのbash出力がコンテキストに永久に残る。「このプロジェクトはどのテストフレームワークを使っているか」という質問は5つのファイルを読む必要があるかもしれないが、親に必要なのは「vitest」という答えだけだ。

## 解決策

```
Parent agent                     Subagent
+------------------+             +------------------+
| messages=[...]   |             | messages=[]      | <-- fresh
|                  |  dispatch   |                  |
| tool: task       | ----------> | while tool_use:  |
|   prompt="..."   |             |   call tools     |
|                  |  summary    |   append results |
|   result = "..." | <---------- | return last text |
+------------------+             +------------------+

Parent context stays clean. Subagent context is discarded.
```

## 仕組み

1. 親に`task`ツールを追加する。子は`task`を除くすべての基本ツールを取得する(再帰的な生成は不可)。

```typescript
const PARENT_TOOLS: Anthropic.Messages.Tool[] = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description: "Spawn a subagent with fresh context.",
    input_schema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
  },
];
```

2. サブエージェントは`messages=[]`で開始し、自身のループを実行する。最終テキストだけが親に返る。

```typescript
async function runSubagent(prompt: string): Promise<string> {
  const subMessages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: prompt },
  ];
  let response!: Anthropic.Messages.Message;
  for (let i = 0; i < 30; i++) {  // safety limit
    response = await client.messages.create({
      model: MODEL, system: SUBAGENT_SYSTEM,
      messages: subMessages,
      tools: CHILD_TOOLS, max_tokens: 8000,
    });
    subMessages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") break;
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler
          ? handler(block.input as ToolInput)
          : `Unknown tool: ${block.name}`;
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, 50_000),
        });
      }
    }
    subMessages.push({ role: "user", content: results });
  }
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("") || "(no summary)";
}
```

子のメッセージ履歴全体(30回以上のツール呼び出し)は破棄される。親は1段落の要約を通常の`tool_result`として受け取る。

## s03からの変更点

| Component      | Before (s03)     | After (s04)               |
|----------------|------------------|---------------------------|
| Tools          | 5                | 5 (base) + task (parent)  |
| Context        | Single shared    | Parent + child isolation  |
| Subagent       | None             | `runSubagent()` function  |
| Return value   | N/A              | Summary text only         |

## 試してみる

```sh
cd learn-claude-code-ts
bun run agents/s04_subagent.ts
```

1. `Use a subtask to find what testing framework this project uses`
2. `Delegate: read all .ts files and summarize what each one does`
3. `Use a task to create a new module, then verify it from here`
