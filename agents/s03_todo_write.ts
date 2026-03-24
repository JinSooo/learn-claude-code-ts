/**
 * s03_todo_write.ts - TodoWrite
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> | Tools   |
 *     |  prompt  |      |       |      | + todo  |
 *     +----------+      +---+---+      +----+----+
 *                            ^               |
 *                            |   tool_result |
 *                            +---------------+
 *                                  |
 *                      +-----------+-----------+
 *                      | TodoManager state     |
 *                      | [ ] task A            |
 *                      | [>] task B <- doing   |
 *                      | [x] task C            |
 *                      +-----------------------+
 *                                  |
 *                      if rounds_since_todo >= 3:
 *                        inject <reminder>
 *
 * Key insight: "The agent can track its own progress -- and I can see it."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";

// Bun loads .env natively; Node needs dotenv
if (typeof (globalThis as Record<string, unknown>).Bun === "undefined") {
  const { config } = await import("dotenv");
  config({ override: true });
}

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

// -- TodoManager: structured state the LLM writes to --

interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

class TodoManager {
  items: TodoItem[] = [];

  update(items: unknown[]): string {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }
    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown>;
      const text = String(item.text ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase();
      const id = String(item.id ?? String(i + 1));

      if (!text) {
        throw new Error(`Item ${id}: text required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${id}: invalid status '${status}'`);
      }
      if (status === "in_progress") {
        inProgressCount++;
      }
      validated.push({ id, text, status: status as TodoItem["status"] });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) return "No todos.";
    const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    const lines = this.items.map((item) => `${markers[item.status]} #${item.id}: ${item.text}`);
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

// -- Tool implementations --

function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const stdout = execSync(command, {
      cwd: WORKDIR,
      shell: "/bin/sh",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = (stdout ?? "").trim();
    return out ? out.slice(0, 50_000) : "(no output)";
  } catch (err: unknown) {
    if (err && typeof err === "object" && "killed" in err && err.killed) {
      return "Error: Timeout (120s)";
    }
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
    return out ? out.slice(0, 50_000) : `Error: ${e.message}`;
  }
}

function runRead(path: string, limit?: number): string {
  try {
    const text = readFileSync(safePath(path), "utf-8");
    let lines = text.split("\n");
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    }
    return lines.join("\n").slice(0, 50_000);
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

function runWrite(path: string, content: string): string {
  try {
    const fp = safePath(path);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

function runEdit(path: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(path);
    const content = readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    writeFileSync(fp, content.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

// -- Dispatch map --
type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:       (input) => runBash(input.command as string),
  read_file:  (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  edit_file:  (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  todo:       (input) => TODO.update(input.items as unknown[]),
};

const TOOLS: Anthropic.Messages.Tool[] = [
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "todo", description: "Update task list. Track progress on multi-step tasks.",
    input_schema: { type: "object" as const, properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["id", "text", "status"] } } }, required: ["items"] } },
];

// -- Agent loop with nag reminder injection --
async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  let roundsSinceTodo = 0;

  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: (Anthropic.Messages.ToolResultBlockParam | Anthropic.Messages.TextBlockParam)[] = [];
    let usedTodo = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler
            ? handler(block.input as ToolInput)
            : `Unknown tool: ${block.name}`;
        } catch (e: unknown) {
          output = `Error: ${e instanceof Error ? e.message : e}`;
        }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        if (block.name === "todo") usedTodo = true;
      }
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    if (roundsSinceTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    messages.push({ role: "user", content: results });
  }
}

// -- Interactive REPL --
const history: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const prompt = (): void => {
  rl.question("\x1b[36ms03 >> \x1b[0m", async (query) => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed || trimmed === "q" || trimmed === "exit") {
      rl.close();
      return;
    }
    history.push({ role: "user", content: query });
    await agentLoop(history);

    const last = history[history.length - 1];
    if (last.role === "assistant" && Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === "text") console.log(block.text);
      }
    }
    console.log();
    prompt();
  });
};

prompt();
