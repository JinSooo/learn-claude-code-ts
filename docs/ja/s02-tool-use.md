# s02: Tool Use

`s01 > [ s02 ] s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"ツールを足すなら、ハンドラーを1つ足すだけ"* -- ループは変わらない。新ツールは dispatch map に登録するだけ。
>
> **Harness 層**: ツール分配 -- モデルが届く範囲を広げる。

## 問題

`bash`だけでは、エージェントは何でもシェル経由で行う。`cat`は予測不能に切り詰め、`sed`は特殊文字で壊れ、すべてのbash呼び出しが制約のないセキュリティ面になる。`read_file`や`write_file`のような専用ツールなら、ツールレベルでパスのサンドボックス化を強制できる。

重要な点: ツールを追加してもループの変更は不要。

## 解決策

```
+--------+      +-------+      +------------------+
|  User  | ---> |  LLM  | ---> | Tool Dispatch    |
| prompt |      |       |      | {                |
+--------+      +---+---+      |   bash: runBash  |
                    ^           |   read: runRead  |
                    |           |   write: runWrite|
                    +-----------+   edit: runEdit  |
                    tool_result | }                |
                                +------------------+

The dispatch map is a Record<string, ToolHandler>: {tool_name: handler_function}.
One lookup replaces any if/else chain.
```

## 仕組み

1. 各ツールにハンドラ関数を定義する。パスのサンドボックス化でワークスペース外への脱出を防ぐ。

```typescript
function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runRead(path: string, limit?: number): string {
  const text = readFileSync(safePath(path), "utf-8");
  let lines = text.split("\n");
  if (limit && limit < lines.length) {
    lines = lines.slice(0, limit);
  }
  return lines.join("\n").slice(0, 50_000);
}
```

2. ディスパッチマップがツール名とハンドラを結びつける。

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:       (input) => runBash(input.command as string),
  read_file:  (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  edit_file:  (input) => runEdit(input.path as string, input.old_text as string,
                                  input.new_text as string),
};
```

3. ループ内で名前によりハンドラをルックアップする。ループ本体はs01から不変。

```typescript
for (const block of response.content) {
  if (block.type === "tool_use") {
    const handler = TOOL_HANDLERS[block.name];
    const output = handler
      ? handler(block.input as ToolInput)
      : `Unknown tool: ${block.name}`;
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: output,
    });
  }
}
```

ツール追加 = ハンドラ追加 + スキーマ追加。ループは決して変わらない。

## s01からの変更点

| Component      | Before (s01)       | After (s02)                |
|----------------|--------------------|----------------------------|
| Tools          | 1 (bash only)      | 4 (bash, read, write, edit)|
| Dispatch       | Hardcoded bash call | `TOOL_HANDLERS` record     |
| Path safety    | None               | `safePath()` sandbox       |
| Agent loop     | Unchanged          | Unchanged                  |

## 試してみる

```sh
cd learn-claude-code-ts
bun run agents/s02_tool_use.ts
```

1. `Read the file package.json`
2. `Create a file called greet.ts with a greet(name) function`
3. `Edit greet.ts to add a JSDoc comment to the function`
4. `Read greet.ts to verify the edit worked`
