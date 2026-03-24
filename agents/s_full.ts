/**
 * s_full.ts - Full Reference Agent
 *
 * Capstone implementation combining every mechanism from s01-s11.
 * Session s12 (task-aware worktree isolation) is taught separately.
 * NOT a teaching session -- this is the "put it all together" reference.
 *
 *     +------------------------------------------------------------------+
 *     |                        FULL AGENT                                 |
 *     |                                                                   |
 *     |  System prompt (s05 skills, task-first + optional todo nag)      |
 *     |                                                                   |
 *     |  Before each LLM call:                                            |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |  |
 *     |  | Auto-compact (s06) |  | notifications    |  | (s09)        |  |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |                                                                   |
 *     |  Tool dispatch (s02 pattern):                                     |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |  | bash   | read     | write    | edit    | TodoWrite |          |
 *     |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 *     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 *     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 *     |  | plan   | idle     | claim    |         |           |          |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |                                                                   |
 *     |  Subagent (s04):  spawn -> work -> return summary                 |
 *     |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
 *     |  Shutdown (s10):  request_id handshake                            |
 *     |  Plan gate (s10): submit -> approve/reject                        |
 *     +------------------------------------------------------------------+
 *
 *     REPL commands: /compact /tasks /team /inbox
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync, exec } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, appendFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
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

const TEAM_DIR = join(WORKDIR, ".team");
const INBOX_DIR = join(TEAM_DIR, "inbox");
const TASKS_DIR = join(WORKDIR, ".tasks");
const SKILLS_DIR = join(WORKDIR, "skills");
const TRANSCRIPT_DIR = join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100_000;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const VALID_MSG_TYPES = new Set([
  "message", "broadcast", "shutdown_request",
  "shutdown_response", "plan_approval_response",
]);

// === SECTION: base_tools ===
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
    return `Wrote ${content.length} bytes to ${path}`;
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

// === SECTION: todos (s03) ===
interface TodoItem {
  content: string;
  status: string;
  activeForm: string;
}

class TodoManager {
  items: TodoItem[] = [];

  update(items: unknown[]): string {
    const validated: TodoItem[] = [];
    let ip = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown>;
      const content = String(item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase();
      const af = String(item.activeForm || "").trim();
      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!af) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") ip++;
      validated.push({ content, status, activeForm: af });
    }
    if (validated.length > 20) throw new Error("Max 20 todos");
    if (ip > 1) throw new Error("Only one in_progress allowed");
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (this.items.length === 0) return "No todos.";
    const lines: string[] = [];
    for (const item of this.items) {
      const m: Record<string, string> = { completed: "[x]", in_progress: "[>]", pending: "[ ]" };
      const marker = m[item.status] || "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      lines.push(`${marker} ${item.content}${suffix}`);
    }
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

// === SECTION: subagent (s04) ===
async function runSubagent(prompt: string, agentType: string = "Explore"): Promise<string> {
  const subTools: Anthropic.Messages.Tool[] = [
    { name: "bash", description: "Run command.",
      input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "read_file", description: "Read file.",
      input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
  ];
  if (agentType !== "Explore") {
    subTools.push(
      { name: "write_file", description: "Write file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Edit file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
    );
  }
  const subHandlers: Record<string, (input: Record<string, unknown>) => string> = {
    bash:       (input) => runBash(input.command as string),
    read_file:  (input) => runRead(input.path as string),
    write_file: (input) => runWrite(input.path as string, input.content as string),
    edit_file:  (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  };
  const subMsgs: Anthropic.Messages.MessageParam[] = [{ role: "user", content: prompt }];
  let resp: Anthropic.Messages.Message | null = null;
  for (let i = 0; i < 30; i++) {
    resp = await client.messages.create({ model: MODEL, messages: subMsgs, tools: subTools, max_tokens: 8000 });
    subMsgs.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") break;
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type === "tool_use") {
        const h = subHandlers[b.name] || (() => "Unknown tool");
        results.push({ type: "tool_result", tool_use_id: b.id, content: String(h(b.input as Record<string, unknown>)).slice(0, 50_000) });
      }
    }
    subMsgs.push({ role: "user", content: results });
  }
  if (resp) {
    const text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return text || "(no summary)";
  }
  return "(subagent failed)";
}

// === SECTION: skills (s05) ===
class SkillLoader {
  skills: Record<string, { meta: Record<string, string>; body: string }> = {};

  constructor(skillsDir: string) {
    if (!existsSync(skillsDir)) return;
    const scanDir = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) scanDir(join(current, entry.name));
        else if (entry.name === "SKILL.md") {
          const text = readFileSync(join(current, entry.name), "utf-8");
          const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
          let meta: Record<string, string> = {};
          let body = text;
          if (match) {
            for (const line of match[1].trim().split("\n")) {
              const idx = line.indexOf(":");
              if (idx !== -1) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
            body = match[2].trim();
          }
          const name = meta.name || basename(current);
          this.skills[name] = { meta, body };
        }
      }
    };
    scanDir(skillsDir);
  }

  descriptions(): string {
    if (Object.keys(this.skills).length === 0) return "(no skills)";
    return Object.entries(this.skills)
      .map(([n, s]) => `  - ${n}: ${s.meta.description || "-"}`)
      .join("\n");
  }

  load(name: string): string {
    const s = this.skills[name];
    if (!s) return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}

// === SECTION: compression (s06) ===
function estimateTokens(messages: Anthropic.Messages.MessageParam[]): number {
  return JSON.stringify(messages, null, 0).length / 4;
}

function microcompact(messages: Anthropic.Messages.MessageParam[]): void {
  const parts: Anthropic.Messages.ToolResultBlockParam[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && "type" in part && part.type === "tool_result") {
          parts.push(part as Anthropic.Messages.ToolResultBlockParam);
        }
      }
    }
  }
  if (parts.length <= 3) return;
  for (const part of parts.slice(0, -3)) {
    if (typeof part.content === "string" && part.content.length > 100) {
      (part as { content: string }).content = "[cleared]";
    }
  }
}

async function autoCompact(messages: Anthropic.Messages.MessageParam[]): Promise<Anthropic.Messages.MessageParam[]> {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const path = join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  const lines = messages.map((msg) => JSON.stringify(msg));
  writeFileSync(path, lines.join("\n") + "\n");
  const convText = JSON.stringify(messages).slice(0, 80_000);
  const resp = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: `Summarize for continuity:\n${convText}` }],
    max_tokens: 2000,
  });
  const summary = (resp.content[0] as Anthropic.Messages.TextBlock).text;
  return [
    { role: "user", content: `[Compressed. Transcript: ${path}]\n${summary}` },
    { role: "assistant", content: "Understood. Continuing with summary context." },
  ];
}

// === SECTION: file_tasks (s07) ===
interface Task {
  id: number;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
}

class TaskManager {
  constructor() {
    mkdirSync(TASKS_DIR, { recursive: true });
  }

  private nextId(): number {
    const ids: number[] = [];
    for (const f of readdirSync(TASKS_DIR)) {
      const m = f.match(/^task_(\d+)\.json$/);
      if (m) ids.push(parseInt(m[1], 10));
    }
    return (ids.length > 0 ? Math.max(...ids) : 0) + 1;
  }

  private load(tid: number): Task {
    const p = join(TASKS_DIR, `task_${tid}.json`);
    if (!existsSync(p)) throw new Error(`Task ${tid} not found`);
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  private save(task: Task): void {
    writeFileSync(join(TASKS_DIR, `task_${task.id}.json`), JSON.stringify(task, null, 2));
  }

  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId(), subject, description,
      status: "pending", owner: null, blockedBy: [], blocks: [],
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  get(tid: number): string {
    return JSON.stringify(this.load(tid), null, 2);
  }

  update(tid: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(tid);
    if (status) {
      task.status = status;
      if (status === "completed") {
        for (const f of readdirSync(TASKS_DIR).filter((n) => /^task_\d+\.json$/.test(n))) {
          const t: Task = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8"));
          if (t.blockedBy.includes(tid)) {
            t.blockedBy = t.blockedBy.filter((id) => id !== tid);
            this.save(t);
          }
        }
      }
      if (status === "deleted") {
        const p = join(TASKS_DIR, `task_${tid}.json`);
        if (existsSync(p)) unlinkSync(p);
        return `Task ${tid} deleted`;
      }
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    if (addBlocks) task.blocks = [...new Set([...task.blocks, ...addBlocks])];
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const files = readdirSync(TASKS_DIR).filter((f) => /^task_\d+\.json$/.test(f)).sort();
    if (files.length === 0) return "No tasks.";
    const lines: string[] = [];
    for (const f of files) {
      const t: Task = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8"));
      const m: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
      const marker = m[t.status] || "[?]";
      const owner = t.owner ? ` @${t.owner}` : "";
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${JSON.stringify(t.blockedBy)})` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${blocked}`);
    }
    return lines.join("\n");
  }

  claim(tid: number, owner: string): string {
    const task = this.load(tid);
    task.owner = owner;
    task.status = "in_progress";
    this.save(task);
    return `Claimed task #${tid} for ${owner}`;
  }
}

// === SECTION: background (s08) ===
interface BgTask { status: string; result: string | null; command: string }
interface BgNotification { task_id: string; status: string; result: string }

class BackgroundManager {
  tasks: Record<string, BgTask> = {};
  private notifications: BgNotification[] = [];

  run(command: string): string {
    const tid = randomUUID().slice(0, 8);
    this.tasks[tid] = { status: "running", result: null, command };
    exec(command, { cwd: WORKDIR, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let output: string; let status: string;
      if (err && err.killed) { output = "Error: Timeout (300s)"; status = "timeout"; }
      else if (err) { output = ((stdout ?? "") + (stderr ?? "")).trim().slice(0, 50_000) || `Error: ${err.message}`; status = "error"; }
      else { output = ((stdout ?? "") + (stderr ?? "")).trim().slice(0, 50_000) || "(no output)"; status = "completed"; }
      this.tasks[tid] = { status, result: output, command };
      this.notifications.push({ task_id: tid, status, result: output.slice(0, 500) });
    });
    return `Background task ${tid} started: ${command.slice(0, 80)}`;
  }

  check(tid?: string): string {
    if (tid) {
      const t = this.tasks[tid];
      if (!t) return `Unknown: ${tid}`;
      return `[${t.status}] ${t.result ?? "(running)"}`;
    }
    const entries = Object.entries(this.tasks);
    if (entries.length === 0) return "No bg tasks.";
    return entries.map(([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`).join("\n");
  }

  drain(): BgNotification[] {
    const items = [...this.notifications];
    this.notifications.length = 0;
    return items;
  }
}

// === SECTION: messaging (s09) ===
class MessageBus {
  constructor() {
    mkdirSync(INBOX_DIR, { recursive: true });
  }

  send(sender: string, to: string, content: string, msgType: string = "message", extra?: Record<string, unknown>): string {
    const msg: Record<string, unknown> = {
      type: msgType, from: sender, content,
      timestamp: Date.now() / 1000,
    };
    if (extra) Object.assign(msg, extra);
    appendFileSync(join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): unknown[] {
    const path = join(INBOX_DIR, `${name}.jsonl`);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf-8").trim();
    if (!text) return [];
    const msgs = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    writeFileSync(path, "");
    return msgs;
  }

  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const n of names) {
      if (n !== sender) { this.send(sender, n, content, "broadcast"); count++; }
    }
    return `Broadcast to ${count} teammates`;
  }
}

// === SECTION: shutdown + plan tracking (s10) ===
const shutdownRequests: Record<string, { target: string; status: string }> = {};
const planRequests: Record<string, { from: string; status: string }> = {};

// === SECTION: team (s09/s11) ===
interface TeamMember { name: string; role: string; status: string }
interface TeamConfig { team_name: string; members: TeamMember[] }

class TeammateManager {
  private bus: MessageBus;
  private taskMgr: TaskManager;
  private configPath: string;
  config: TeamConfig;

  constructor(bus: MessageBus, taskMgr: TaskManager) {
    mkdirSync(TEAM_DIR, { recursive: true });
    this.bus = bus;
    this.taskMgr = taskMgr;
    this.configPath = join(TEAM_DIR, "config.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (existsSync(this.configPath)) return JSON.parse(readFileSync(this.configPath, "utf-8"));
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  private setStatus(name: string, status: string): void {
    const member = this.findMember(name);
    if (member) { member.status = status; this.saveConfig(); }
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this.findMember(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();
    // Fire-and-forget async teammate loop (Node.js equivalent of threading)
    this.teammateLoop(name, role, prompt).catch(() => this.setStatus(name, "shutdown"));
    return `Spawned '${name}' (role: ${role})`;
  }

  private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
      `Use idle when done with current work. You may auto-claim tasks.`;
    const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: prompt }];
    const tools: Anthropic.Messages.Tool[] = [
      { name: "bash", description: "Run command.",
        input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "Write file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Edit file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "Send message.",
        input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
      { name: "idle", description: "Signal no more work.",
        input_schema: { type: "object" as const, properties: {} } },
      { name: "claim_task", description: "Claim task by ID.",
        input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    ];

    while (true) {
      // -- WORK PHASE --
      for (let round = 0; round < 50; round++) {
        const inbox = this.bus.readInbox(name) as Record<string, unknown>[];
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") { this.setStatus(name, "shutdown"); return; }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
        let response: Anthropic.Messages.Message;
        try {
          response = await client.messages.create({
            model: MODEL, system: sysPrompt, messages, tools, max_tokens: 8000,
          });
        } catch {
          this.setStatus(name, "shutdown"); return;
        }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;

        const results: Anthropic.Messages.ToolResultBlockParam[] = [];
        let idleRequested = false;
        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output: string;
            if (block.name === "idle") {
              idleRequested = true;
              output = "Entering idle phase.";
            } else if (block.name === "claim_task") {
              output = this.taskMgr.claim((block.input as Record<string, unknown>).task_id as number, name);
            } else if (block.name === "send_message") {
              const inp = block.input as Record<string, unknown>;
              output = this.bus.send(name, inp.to as string, inp.content as string);
            } else {
              const dispatch: Record<string, (input: Record<string, unknown>) => string> = {
                bash: (inp) => runBash(inp.command as string),
                read_file: (inp) => runRead(inp.path as string),
                write_file: (inp) => runWrite(inp.path as string, inp.content as string),
                edit_file: (inp) => runEdit(inp.path as string, inp.old_text as string, inp.new_text as string),
              };
              const handler = dispatch[block.name] || (() => "Unknown");
              output = handler(block.input as Record<string, unknown>);
            }
            console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
            results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          }
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) break;
      }

      // -- IDLE PHASE: poll for messages and unclaimed tasks --
      this.setStatus(name, "idle");
      let resume = false;
      const maxPolls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));
      for (let p = 0; p < maxPolls; p++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));
        const inbox = this.bus.readInbox(name) as Record<string, unknown>[];
        if (inbox.length > 0) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") { this.setStatus(name, "shutdown"); return; }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }
        // Auto-claim unclaimed tasks (s11)
        const unclaimed: Task[] = [];
        for (const f of readdirSync(TASKS_DIR).filter((n) => /^task_\d+\.json$/.test(n)).sort()) {
          const t: Task = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8"));
          if (t.status === "pending" && !t.owner && (!t.blockedBy || t.blockedBy.length === 0)) {
            unclaimed.push(t);
          }
        }
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          this.taskMgr.claim(task.id, name);
          // Identity re-injection for compressed contexts
          if (messages.length <= 3) {
            messages.unshift({ role: "user", content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>` });
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }
          messages.push({ role: "user", content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>` });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }
      if (!resume) { this.setStatus(name, "shutdown"); return; }
      this.setStatus(name, "working");
    }
  }

  listAll(): string {
    if (this.config.members.length === 0) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

// === SECTION: global_instances ===
const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

// === SECTION: system_prompt ===
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;

// === SECTION: shutdown_protocol (s10) ===
function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

// === SECTION: plan_approval (s10) ===
function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId, approve, feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

// === SECTION: tool_dispatch (s02) ===
type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => string | Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:             (input) => runBash(input.command as string),
  read_file:        (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file:       (input) => runWrite(input.path as string, input.content as string),
  edit_file:        (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  TodoWrite:        (input) => TODO.update(input.items as unknown[]),
  task:             (input) => runSubagent(input.prompt as string, (input.agent_type as string) || "Explore"),
  load_skill:       (input) => SKILLS.load(input.name as string),
  compress:         () => "Compressing...",
  background_run:   (input) => BG.run(input.command as string),
  check_background: (input) => BG.check(input.task_id as string | undefined),
  task_create:      (input) => TASK_MGR.create(input.subject as string, (input.description as string) || ""),
  task_get:         (input) => TASK_MGR.get(input.task_id as number),
  task_update:      (input) => TASK_MGR.update(input.task_id as number, input.status as string | undefined, input.add_blocked_by as number[] | undefined, input.add_blocks as number[] | undefined),
  task_list:        () => TASK_MGR.listAll(),
  spawn_teammate:   (input) => TEAM.spawn(input.name as string, input.role as string, input.prompt as string),
  list_teammates:   () => TEAM.listAll(),
  send_message:     (input) => BUS.send("lead", input.to as string, input.content as string, (input.msg_type as string) || "message"),
  read_inbox:       () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:        (input) => BUS.broadcast("lead", input.content as string, TEAM.memberNames()),
  shutdown_request: (input) => handleShutdownRequest(input.teammate as string),
  plan_approval:    (input) => handlePlanReview(input.request_id as string, input.approve as boolean, (input.feedback as string) || ""),
  idle:             () => "Lead does not idle.",
  claim_task:       (input) => TASK_MGR.claim(input.task_id as number, "lead"),
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
  { name: "TodoWrite", description: "Update task tracking list.",
    input_schema: { type: "object" as const, properties: { items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } }, required: ["content", "status", "activeForm"] } } }, required: ["items"] } },
  { name: "task", description: "Spawn a subagent for isolated exploration or work.",
    input_schema: { type: "object" as const, properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } }, required: ["prompt"] } },
  { name: "load_skill", description: "Load specialized knowledge by name.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compress", description: "Manually compress conversation context.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "background_run", description: "Run command in background thread.",
    input_schema: { type: "object" as const, properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "string" } } } },
  { name: "task_create", description: "Create a persistent file task.",
    input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get", description: "Get task details by ID.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or dependencies.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "spawn_teammate", description: "Spawn a persistent autonomous teammate.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.",
    input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "broadcast", description: "Send message to all teammates.",
    input_schema: { type: "object" as const, properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down.",
    input_schema: { type: "object" as const, properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan.",
    input_schema: { type: "object" as const, properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle", description: "Enter idle state.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "claim_task", description: "Claim a task from the board.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

// === SECTION: agent_loop ===
async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  let roundsWithoutTodo = 0;
  while (true) {
    // s06: compression pipeline
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
    // s08: drain background notifications
    const notifs = BG.drain();
    if (notifs.length > 0) {
      const txt = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    // s10: check lead inbox
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }
    // LLM call
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    // Tool execution
    const results: (Anthropic.Messages.ToolResultBlockParam | Anthropic.Messages.TextBlockParam)[] = [];
    let usedTodo = false;
    let manualCompress = false;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (block.name === "compress") manualCompress = true;
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? String(await handler(block.input as ToolInput)) : `Unknown tool: ${block.name}`;
        } catch (e: unknown) {
          output = `Error: ${e instanceof Error ? e.message : e}`;
        }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        if (block.name === "TodoWrite") usedTodo = true;
      }
    }
    // s03: nag reminder (only when todo workflow is active)
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    messages.push({ role: "user", content: results as Anthropic.Messages.ContentBlockParam[] });
    // s06: manual compress
    if (manualCompress) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
  }
}

// === SECTION: repl ===
const history: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const promptUser = (): void => {
  rl.question("\x1b[36ms_full >> \x1b[0m", async (query) => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed || trimmed === "q" || trimmed === "exit") { rl.close(); return; }
    if (query.trim() === "/compact") {
      if (history.length > 0) {
        console.log("[manual compact via /compact]");
        const compacted = await autoCompact(history);
        history.length = 0;
        history.push(...compacted);
      }
      promptUser();
      return;
    }
    if (query.trim() === "/tasks") { console.log(TASK_MGR.listAll()); promptUser(); return; }
    if (query.trim() === "/team") { console.log(TEAM.listAll()); promptUser(); return; }
    if (query.trim() === "/inbox") { console.log(JSON.stringify(BUS.readInbox("lead"), null, 2)); promptUser(); return; }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    console.log();
    promptUser();
  });
};

promptUser();
