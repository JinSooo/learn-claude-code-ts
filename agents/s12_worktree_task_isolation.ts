/**
 * s12_worktree_task_isolation.ts - Worktree + Task Isolation
 *
 * Directory-level isolation for parallel task execution.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from "node:fs";
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

function detectRepoRoot(cwd: string): string | null {
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result && existsSync(result) ? result : null;
  } catch {
    return null;
  }
}

const REPO_ROOT = detectRepoRoot(WORKDIR) || WORKDIR;

const SYSTEM =
  `You are a coding agent at ${WORKDIR}. ` +
  "Use task + worktree tools for multi-task work. " +
  "For parallel or risky changes: create tasks, allocate worktree lanes, " +
  "run commands in those lanes, then choose keep/remove for closeout. " +
  "Use worktree_events when you need lifecycle visibility.";

// -- EventBus: append-only lifecycle events for observability --
class EventBus {
  private path: string;

  constructor(eventLogPath: string) {
    this.path = eventLogPath;
    mkdirSync(dirname(eventLogPath), { recursive: true });
    if (!existsSync(this.path)) writeFileSync(this.path, "");
  }

  emit(
    event: string,
    task: Record<string, unknown> = {},
    worktree: Record<string, unknown> = {},
    error?: string,
  ): void {
    const payload: Record<string, unknown> = {
      event,
      ts: Date.now() / 1000,
      task,
      worktree,
    };
    if (error) payload.error = error;
    appendFileSync(this.path, JSON.stringify(payload) + "\n");
  }

  listRecent(limit: number = 20): string {
    const n = Math.max(1, Math.min(limit || 20, 200));
    const lines = readFileSync(this.path, "utf-8").split("\n").filter(Boolean);
    const recent = lines.slice(-n);
    const items = recent.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: "parse_error", raw: line };
      }
    });
    return JSON.stringify(items, null, 2);
  }
}

// -- TaskManager: persistent task board with optional worktree binding --
interface TaskData {
  id: number;
  subject: string;
  description: string;
  status: string;
  owner: string;
  worktree: string;
  blockedBy: number[];
  created_at: number;
  updated_at: number;
}

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    mkdirSync(tasksDir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const ids: number[] = [];
    for (const f of readdirSync(this.dir)) {
      const m = f.match(/^task_(\d+)\.json$/);
      if (m) ids.push(parseInt(m[1], 10));
    }
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  private taskPath(taskId: number): string {
    return join(this.dir, `task_${taskId}.json`);
  }

  private load(taskId: number): TaskData {
    const p = this.taskPath(taskId);
    if (!existsSync(p)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  private save(task: TaskData): void {
    writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2));
  }

  taskExists(taskId: number): boolean {
    return existsSync(this.taskPath(taskId));
  }

  create(subject: string, description: string = ""): string {
    const task: TaskData = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this.save(task);
    this.nextId += 1;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(taskId: number, status?: string, owner?: string): string {
    const task = this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
    }
    if (owner !== undefined) task.owner = owner;
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(taskId: number, worktree: string, owner: string = ""): string {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId: number): string {
    const task = this.load(taskId);
    task.worktree = "";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const files = readdirSync(this.dir)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort();
    if (files.length === 0) return "No tasks.";
    const lines: string[] = [];
    for (const f of files) {
      const t: TaskData = JSON.parse(readFileSync(join(this.dir, f), "utf-8"));
      const marker: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
      const m = marker[t.status] || "[?]";
      const ownerStr = t.owner ? ` owner=${t.owner}` : "";
      const wtStr = t.worktree ? ` wt=${t.worktree}` : "";
      lines.push(`${m} #${t.id}: ${t.subject}${ownerStr}${wtStr}`);
    }
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(join(REPO_ROOT, ".worktrees", "events.jsonl"));

// -- WorktreeManager: create/list/run/remove git worktrees + lifecycle index --
interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id: number | null;
  status: string;
  created_at?: number;
  removed_at?: number;
  kept_at?: number;
}

interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

class WorktreeManager {
  private repoRoot: string;
  private tasks: TaskManager;
  private events: EventBus;
  private dir: string;
  private indexPath: string;
  gitAvailable: boolean;

  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = join(repoRoot, ".worktrees");
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, "index.json");
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2));
    }
    this.gitAvailable = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  }

  private runGit(args: string[]): string {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }
    try {
      const stdout = execSync(`git ${args.join(" ")}`, {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });
      return (stdout ?? "").trim() || "(no output)";
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const msg = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
      throw new Error(msg || `git ${args.join(" ")} failed`);
    }
  }

  private loadIndex(): WorktreeIndex {
    return JSON.parse(readFileSync(this.indexPath, "utf-8"));
  }

  private saveIndex(data: WorktreeIndex): void {
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  private find(name: string): WorktreeEntry | null {
    const idx = this.loadIndex();
    return idx.worktrees.find((wt) => wt.name === name) || null;
  }

  private validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  create(name: string, taskId?: number, baseRef: string = "HEAD"): string {
    this.validateName(name);
    if (this.find(name)) throw new Error(`Worktree '${name}' already exists in index`);
    if (taskId !== undefined && !this.tasks.taskExists(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }

    const wtPath = join(this.dir, name);
    const branch = `wt/${name}`;
    this.events.emit(
      "worktree.create.before",
      taskId !== undefined ? { id: taskId } : {},
      { name, base_ref: baseRef },
    );
    try {
      this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);

      const entry: WorktreeEntry = {
        name,
        path: wtPath,
        branch,
        task_id: taskId ?? null,
        status: "active",
        created_at: Date.now() / 1000,
      };

      const idx = this.loadIndex();
      idx.worktrees.push(entry);
      this.saveIndex(idx);

      if (taskId !== undefined) {
        this.tasks.bindWorktree(taskId, name);
      }

      this.events.emit(
        "worktree.create.after",
        taskId !== undefined ? { id: taskId } : {},
        { name, path: wtPath, branch, status: "active" },
      );
      return JSON.stringify(entry, null, 2);
    } catch (e: unknown) {
      this.events.emit(
        "worktree.create.failed",
        taskId !== undefined ? { id: taskId } : {},
        { name, base_ref: baseRef },
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }
  }

  listAll(): string {
    const idx = this.loadIndex();
    const wts = idx.worktrees;
    if (wts.length === 0) return "No worktrees in index.";
    const lines: string[] = [];
    for (const wt of wts) {
      const suffix = wt.task_id != null ? ` task=${wt.task_id}` : "";
      lines.push(
        `[${wt.status || "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch || "-"})${suffix}`,
      );
    }
    return lines.join("\n");
  }

  status(name: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;
    try {
      const stdout = execSync("git status --short --branch", {
        cwd: wt.path,
        encoding: "utf-8",
        timeout: 60_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const text = (stdout ?? "").trim();
      return text || "Clean worktree";
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return ((e.stdout ?? "") + (e.stderr ?? "")).trim() || "Clean worktree";
    }
  }

  run(name: string, command: string): string {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";

    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    if (!existsSync(wt.path)) return `Error: Worktree path missing: ${wt.path}`;

    try {
      const stdout = execSync(command, {
        cwd: wt.path,
        shell: "/bin/sh",
        encoding: "utf-8",
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out = (stdout ?? "").trim();
      return out ? out.slice(0, 50_000) : "(no output)";
    } catch (err: unknown) {
      if (err && typeof err === "object" && "killed" in err && err.killed) return "Error: Timeout (300s)";
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
      return out ? out.slice(0, 50_000) : `Error: ${e.message}`;
    }
  }

  remove(name: string, force: boolean = false, completeTask: boolean = false): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;

    this.events.emit(
      "worktree.remove.before",
      wt.task_id != null ? { id: wt.task_id } : {},
      { name, path: wt.path },
    );
    try {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(wt.path);
      this.runGit(args);

      if (completeTask && wt.task_id != null) {
        const before = JSON.parse(this.tasks.get(wt.task_id));
        this.tasks.update(wt.task_id, "completed");
        this.tasks.unbindWorktree(wt.task_id);
        this.events.emit(
          "task.completed",
          { id: wt.task_id, subject: before.subject || "", status: "completed" },
          { name },
        );
      }

      const idx = this.loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) {
          item.status = "removed";
          item.removed_at = Date.now() / 1000;
        }
      }
      this.saveIndex(idx);

      this.events.emit(
        "worktree.remove.after",
        wt.task_id != null ? { id: wt.task_id } : {},
        { name, path: wt.path, status: "removed" },
      );
      return `Removed worktree '${name}'`;
    } catch (e: unknown) {
      this.events.emit(
        "worktree.remove.failed",
        wt.task_id != null ? { id: wt.task_id } : {},
        { name, path: wt.path },
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }
  }

  keep(name: string): string {
    const wt = this.find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;

    const idx = this.loadIndex();
    let kept: WorktreeEntry | null = null;
    for (const item of idx.worktrees) {
      if (item.name === name) {
        item.status = "kept";
        item.kept_at = Date.now() / 1000;
        kept = item;
      }
    }
    this.saveIndex(idx);

    this.events.emit(
      "worktree.keep",
      wt.task_id != null ? { id: wt.task_id } : {},
      { name, path: wt.path, status: "kept" },
    );
    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}

const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

// -- Base tools (kept minimal, same style as previous sessions) --
function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const stdout = execSync(command, {
      cwd: WORKDIR, shell: "/bin/sh", timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024, encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
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
    const c = readFileSync(fp, "utf-8");
    if (!c.includes(oldText)) return `Error: Text not found in ${path}`;
    writeFileSync(fp, c.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (e: unknown) { return `Error: ${e instanceof Error ? e.message : e}`; }
}

// -- Tool dispatch --
type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:                (input) => runBash(input.command as string),
  read_file:           (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file:          (input) => runWrite(input.path as string, input.content as string),
  edit_file:           (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  task_create:         (input) => TASKS.create(input.subject as string, (input.description as string) || ""),
  task_list:           () => TASKS.listAll(),
  task_get:            (input) => TASKS.get(input.task_id as number),
  task_update:         (input) => TASKS.update(input.task_id as number, input.status as string | undefined, input.owner as string | undefined),
  task_bind_worktree:  (input) => TASKS.bindWorktree(input.task_id as number, input.worktree as string, (input.owner as string) || ""),
  worktree_create:     (input) => WORKTREES.create(input.name as string, input.task_id as number | undefined, (input.base_ref as string) || "HEAD"),
  worktree_list:       () => WORKTREES.listAll(),
  worktree_status:     (input) => WORKTREES.status(input.name as string),
  worktree_run:        (input) => WORKTREES.run(input.name as string, input.command as string),
  worktree_keep:       (input) => WORKTREES.keep(input.name as string),
  worktree_remove:     (input) => WORKTREES.remove(input.name as string, (input.force as boolean) || false, (input.complete_task as boolean) || false),
  worktree_events:     (input) => EVENTS.listRecent((input.limit as number) || 20),
};

const TOOLS: Anthropic.Messages.Tool[] = [
  { name: "bash", description: "Run a shell command in the current workspace (blocking).",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_create", description: "Create a new task on the shared task board.",
    input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_list", description: "List all tasks with status, owner, and worktree binding.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "task_get", description: "Get task details by ID.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or owner.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, owner: { type: "string" } }, required: ["task_id"] } },
  { name: "task_bind_worktree", description: "Bind a task to a worktree name.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } }, required: ["task_id", "worktree"] } },
  { name: "worktree_create", description: "Create a git worktree and optionally bind it to a task.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] } },
  { name: "worktree_list", description: "List worktrees tracked in .worktrees/index.json.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "worktree_status", description: "Show git status for one worktree.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_run", description: "Run a shell command in a named worktree directory.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
  { name: "worktree_remove", description: "Remove a worktree and optionally mark its bound task completed.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name"] } },
  { name: "worktree_keep", description: "Mark a worktree as kept in lifecycle state without removing it.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_events", description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
    input_schema: { type: "object" as const, properties: { limit: { type: "integer" } } } },
];

// -- Agent loop --
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
        try {
          output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`;
        } catch (e: unknown) {
          output = `Error: ${e instanceof Error ? e.message : e}`;
        }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

// -- Interactive REPL --
console.log(`Repo root for s12: ${REPO_ROOT}`);
if (!WORKTREES.gitAvailable) {
  console.log("Note: Not in a git repo. worktree_* tools will return errors.");
}

const history: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const prompt = (): void => {
  rl.question("\x1b[36ms12 >> \x1b[0m", async (query) => {
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
