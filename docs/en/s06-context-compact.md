# s06: Context Compact

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> *"Context will fill up; you need a way to make room"* -- three-layer compression strategy for infinite sessions.
>
> **Harness layer**: Compression -- clean memory for infinite sessions.

## Problem

The context window is finite. A single `read_file` on a 1000-line file costs ~4000 tokens. After reading 30 files and running 20 bash commands, you hit 100,000+ tokens. The agent cannot work on large codebases without compression.

## Solution

Three layers, increasing in aggressiveness:

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

## How It Works

1. **Layer 1 -- microCompact**: Before each LLM call, replace old tool results with placeholders.

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

2. **Layer 2 -- autoCompact**: When tokens exceed threshold, save full transcript to disk, then ask the LLM to summarize.

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

3. **Layer 3 -- manual compact**: The `compact` tool triggers the same summarization on demand.

4. The loop integrates all three:

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

Transcripts preserve full history on disk. Nothing is truly lost -- just moved out of active context.

## What Changed From s05

| Component      | Before (s05)     | After (s06)                |
|----------------|------------------|----------------------------|
| Tools          | 5                | 5 (base + compact)         |
| Context mgmt   | None             | Three-layer compression    |
| Micro-compact  | None             | Old results -> placeholders|
| Auto-compact   | None             | Token threshold trigger    |
| Transcripts    | None             | Saved to .transcripts/     |

## Try It

```sh
cd learn-claude-code-ts
bun run agents/s06_context_compact.ts
```

1. `Read every TypeScript file in the agents/ directory one by one` (watch micro-compact replace old results)
2. `Keep reading files until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`
