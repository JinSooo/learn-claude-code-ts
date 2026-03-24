/**
 * s07_task_system.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createInterface } from "node:readline";

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
const TASKS_DIR = join(WORKDIR, ".tasks");

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// -- TaskManager: CRUD with dependency graph, persisted as JSON files --
interface Task {
  id: number; subject: string; description: string;
  status: string; blockedBy: number[]; blocks: number[]; owner: string;
}

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = readdirSync(this.dir).filter((f) => f.match(/^task_\d+\.json$/));
    const ids = files.map((f) => parseInt(f.replace("task_", "").replace(".json", ""), 10));
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private load(taskId: number): Task {
    try { return JSON.parse(readFileSync(join(this.dir, `task_${taskId}.json`), "utf-8")); }
    catch { throw new Error(`Task ${taskId} not found`); }
  }

  private save(task: Task): void {
    writeFileSync(join(this.dir, `task_${task.id}.json`), JSON.stringify(task, null, 2));
  }

  create(subject: string, description = ""): string {
    const task: Task = { id: this.nextId, subject, description, status: "pending", blockedBy: [], blocks: [], owner: "" };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(taskId: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) throw new Error(`Invalid status: ${status}`);
      task.status = status;
      if (status === "completed") this.clearDependency(taskId);
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) { blocked.blockedBy.push(taskId); this.save(blocked); }
        } catch { /* skip */ }
      }
    }
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  private clearDependency(completedId: number): void {
    const files = readdirSync(this.dir).filter((f) => f.match(/^task_\d+\.json$/));
    for (const f of files) {
      const task: Task = JSON.parse(readFileSync(join(this.dir, f), "utf-8"));
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this.save(task);
      }
    }
  }

  listAll(): string {
    const files = readdirSync(this.dir).filter((f) => f.match(/^task_\d+\.json$/)).sort();
    if (files.length === 0) return "No tasks.";
    const markers: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    return files.map((f) => {
      const t: Task = JSON.parse(readFileSync(join(this.dir, f), "utf-8"));
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${JSON.stringify(t.blockedBy)})` : "";
      return `${markers[t.status] || "[?]"} #${t.id}: ${t.subject}${blocked}`;
    }).join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);

// -- Tool implementations --
function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const stdout = execSync(command, { cwd: WORKDIR, shell: "/bin/sh", timeout: 120_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const out = (stdout ?? "").trim();
    return out ? out.slice(0, 50_000) : "(no output)";
  } catch (err: unknown) {
    if (err && typeof err === "object" && "killed" in err && err.killed) return "Error: Timeout (120s)";
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
    return out ? out.slice(0, 50_000) : `Error: ${e.message}`;
  }
}

function runRead(path: string, limit?: number): string {
  try {
    const text = readFileSync(safePath(path), "utf-8");
    let lines = text.split("\n");
    if (limit && limit < lines.length) lines = [...lines.slice(0, limit), `... (${lines.length - limit} more)`];
    return lines.join("\n").slice(0, 50_000);
  } catch (e: unknown) { return `Error: ${e instanceof Error ? e.message : e}`; }
}

function runWrite(path: string, content: string): string {
  try {
    const fp = safePath(path);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e: unknown) { return `Error: ${e instanceof Error ? e.message : e}`; }
}

function runEdit(path: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(path);
    const content = readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) return `Error: Text not found in ${path}`;
    writeFileSync(fp, content.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (e: unknown) { return `Error: ${e instanceof Error ? e.message : e}`; }
}

type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:        (input) => runBash(input.command as string),
  read_file:   (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file:  (input) => runWrite(input.path as string, input.content as string),
  edit_file:   (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  task_create: (input) => TASKS.create(input.subject as string, (input.description as string) ?? ""),
  task_update: (input) => TASKS.update(input.task_id as number, input.status as string | undefined, input.addBlockedBy as number[] | undefined, input.addBlocks as number[] | undefined),
  task_list:   () => TASKS.listAll(),
  task_get:    (input) => TASKS.get(input.task_id as number),
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
  { name: "task_create", description: "Create a new task.",
    input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_update", description: "Update a task's status or dependencies.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, addBlockedBy: { type: "array", items: { type: "integer" } }, addBlocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks with status summary.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "task_get", description: "Get full details of a task by ID.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try { output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`; }
        catch (e: unknown) { output = `Error: ${e instanceof Error ? e.message : e}`; }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

// -- Interactive REPL --
const history: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const prompt = (): void => {
  rl.question("\x1b[36ms07 >> \x1b[0m", async (query) => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed || trimmed === "q" || trimmed === "exit") { rl.close(); return; }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    const last = history[history.length - 1];
    if (last.role === "assistant" && Array.isArray(last.content)) {
      for (const block of last.content) { if (block.type === "text") console.log(block.text); }
    }
    console.log();
    prompt();
  });
};

prompt();
