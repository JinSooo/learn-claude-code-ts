/**
 * s08_background_tasks.ts - Background Tasks
 *
 * Run commands in background. A notification queue is drained
 * before each LLM call to deliver results.
 *
 *     Main thread                Background (async)
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes   |
 *     | ...             |        | ...             |
 *     | [LLM call] <---+------- | push(result)    |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync, exec } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// -- BackgroundManager: async execution + notification queue --
interface BgTask { status: string; result: string | null; command: string }
interface BgNotification { task_id: string; status: string; command: string; result: string }

class BackgroundManager {
  tasks: Record<string, BgTask> = {};
  private notifications: BgNotification[] = [];

  run(command: string): string {
    const taskId = randomUUID().slice(0, 8);
    this.tasks[taskId] = { status: "running", result: null, command };
    exec(command, { cwd: WORKDIR, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let output: string; let status: string;
      if (err && err.killed) { output = "Error: Timeout (300s)"; status = "timeout"; }
      else if (err) { output = ((stdout ?? "") + (stderr ?? "")).trim().slice(0, 50_000) || `Error: ${err.message}`; status = "error"; }
      else { output = ((stdout ?? "") + (stderr ?? "")).trim().slice(0, 50_000) || "(no output)"; status = "completed"; }
      this.tasks[taskId] = { status, result: output, command };
      this.notifications.push({ task_id: taskId, status, command: command.slice(0, 80), result: output.slice(0, 500) });
    });
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  check(taskId?: string): string {
    if (taskId) {
      const t = this.tasks[taskId];
      if (!t) return `Error: Unknown task ${taskId}`;
      return `[${t.status}] ${t.command.slice(0, 60)}\n${t.result ?? "(running)"}`;
    }
    const entries = Object.entries(this.tasks);
    if (entries.length === 0) return "No background tasks.";
    return entries.map(([tid, t]) => `${tid}: [${t.status}] ${t.command.slice(0, 60)}`).join("\n");
  }

  drainNotifications(): BgNotification[] {
    const items = [...this.notifications];
    this.notifications.length = 0;
    return items;
  }
}

const BG = new BackgroundManager();

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
  bash:             (input) => runBash(input.command as string),
  read_file:        (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file:       (input) => runWrite(input.path as string, input.content as string),
  edit_file:        (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  background_run:   (input) => BG.run(input.command as string),
  check_background: (input) => BG.check(input.task_id as string | undefined),
};

const TOOLS: Anthropic.Messages.Tool[] = [
  { name: "bash", description: "Run a shell command (blocking).",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "background_run", description: "Run command in background. Returns task_id immediately.",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status. Omit task_id to list all.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "string" } } } },
];

async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  while (true) {
    // Drain background notifications and inject before LLM call
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${notifText}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }

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
  rl.question("\x1b[36ms08 >> \x1b[0m", async (query) => {
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
