# s02: Tool Use (工具使用)

`s01 > [ s02 ] s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"加一个工具, 只加一个 handler"* -- 循环不用动, 新工具注册进 dispatch map 就行。
>
> **Harness 层**: 工具分发 -- 扩展模型能触达的边界。

## 问题

只有 `bash` 时, 所有操作都走 shell。`cat` 截断不可预测, `sed` 遇到特殊字符就崩, 每次 bash 调用都是不受约束的安全面。专用工具 (`read_file`, `write_file`) 可以在工具层面做路径沙箱。

关键洞察: 加工具不需要改循环。

## 解决方案

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

## 工作原理

1. 每个工具有一个处理函数。路径沙箱防止逃逸工作区。

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

2. dispatch map 将工具名映射到处理函数。

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:       (input) => runBash(input.command as string),
  read_file:  (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  edit_file:  (input) => runEdit(input.path as string, input.old_text as string,
                                  input.new_text as string),
};
```

3. 循环中按名称查找处理函数。循环体本身与 s01 完全一致。

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

加工具 = 加 handler + 加 schema。循环永远不变。

## 相对 s01 的变更

| 组件           | 之前 (s01)         | 之后 (s02)                     |
|----------------|--------------------|--------------------------------|
| Tools          | 1 (仅 bash)        | 4 (bash, read, write, edit)    |
| Dispatch       | 硬编码 bash 调用   | `TOOL_HANDLERS` record         |
| 路径安全       | 无                 | `safePath()` 沙箱              |
| Agent loop     | 不变               | 不变                           |

## 试一试

```sh
cd learn-claude-code-ts
bun run agents/s02_tool_use.ts
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Read the file package.json`
2. `Create a file called greet.ts with a greet(name) function`
3. `Edit greet.ts to add a JSDoc comment to the function`
4. `Read greet.ts to verify the edit worked`
