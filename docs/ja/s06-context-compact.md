# s06: Context Compact

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> *"コンテキストはいつか溢れる、空ける手段が要る"* -- 3層圧縮で無限セッションを実現。
>
> **Harness 層**: 圧縮 -- クリーンな記憶、無限のセッション。

## 問題

コンテキストウィンドウは有限だ。1000行のファイルに対する`read_file`1回で約4000トークンを消費する。30ファイルを読み20回のbashコマンドを実行すると、100,000トークン超。圧縮なしでは、エージェントは大規模コードベースで作業できない。

## 解決策

積極性を段階的に上げる3層構成:

```
Every turn:
+------------------+
| Tool call result |
+------------------+
        |
        v
[Layer 1: microCompact]        (silent, every turn)
  Replace tool_result > 3 turns old
  with "[Previous: used {tool_name}]"
        |
        v
[Check: tokens > 50000?]
   |               |
   no              yes
   |               |
   v               v
continue    [Layer 2: autoCompact]
              Save transcript to .transcripts/
              LLM summarizes conversation.
              Replace all messages with [summary].
                    |
                    v
            [Layer 3: compact tool]
              Model calls compact explicitly.
              Same summarization as autoCompact.
```

## 仕組み

1. **第1層 -- microCompact**: 各LLM呼び出しの前に、古いツール結果をプレースホルダーに置換する。

```typescript
function microCompact(messages: Anthropic.Messages.MessageParam[]): void {
  const toolResults: Array<{ msgIdx: number; partIdx: number; part: Record<string, unknown> }> = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx] as Record<string, unknown>;
        if (part && part.type === "tool_result") {
          toolResults.push({ msgIdx, partIdx, part });
        }
      }
    }
  }
  if (toolResults.length <= KEEP_RECENT) return;
  for (const { part } of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof part.content === "string" && part.content.length > 100) {
      part.content = `[Previous: used ${toolName}]`;
    }
  }
}
```

2. **第2層 -- autoCompact**: トークンが閾値を超えたら、完全なトランスクリプトをディスクに保存し、LLMに要約を依頼する。

```typescript
async function autoCompact(
  messages: Anthropic.Messages.MessageParam[],
): Promise<Anthropic.Messages.MessageParam[]> {
  // Save transcript for recovery
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  for (const msg of messages) {
    appendFileSync(transcriptPath, JSON.stringify(msg) + "\n");
  }
  // LLM summarizes
  const conversationText = JSON.stringify(messages).slice(0, 80_000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content:
      "Summarize this conversation for continuity..." + conversationText }],
    max_tokens: 2000,
  });
  const summary = response.content[0].type === "text" ? response.content[0].text : "";
  return [
    { role: "user", content: `[Compressed]\n\n${summary}` },
    { role: "assistant", content: "Understood. Continuing." },
  ];
}
```

3. **第3層 -- manual compact**: `compact`ツールが同じ要約処理をオンデマンドでトリガーする。

4. ループが3層すべてを統合する:

```typescript
async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  while (true) {
    microCompact(messages);                                    // Layer 1
    if (estimateTokens(messages) > THRESHOLD) {
      const compacted = await autoCompact(messages);           // Layer 2
      messages.splice(0, messages.length, ...compacted);
    }
    const response = await client.messages.create(/* ... */);
    // ... tool execution ...
    if (manualCompact) {
      const compacted = await autoCompact(messages);           // Layer 3
      messages.splice(0, messages.length, ...compacted);
    }
  }
}
```

トランスクリプトがディスク上に完全な履歴を保持する。何も真に失われず、アクティブなコンテキストの外に移動されるだけ。

## s05からの変更点

| Component      | Before (s05)     | After (s06)                |
|----------------|------------------|----------------------------|
| Tools          | 5                | 5 (base + compact)         |
| Context mgmt   | None             | Three-layer compression    |
| Micro-compact  | None             | Old results -> placeholders|
| Auto-compact   | None             | Token threshold trigger    |
| Transcripts    | None             | Saved to .transcripts/     |

## 試してみる

```sh
cd learn-claude-code-ts
bun run agents/s06_context_compact.ts
```

1. `Read every TypeScript file in the agents/ directory one by one` (micro-compactが古い結果を置換するのを観察する)
2. `Keep reading files until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`
