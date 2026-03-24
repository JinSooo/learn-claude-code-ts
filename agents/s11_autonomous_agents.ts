/**
 * s11_autonomous_agents.ts - Autonomous Agents
 *
 * Idle cycle with task board polling, auto-claiming unclaimed tasks, and
 * identity re-injection after context compression. Builds on s10's protocols.
 *
 *     Teammate lifecycle:
 *     +-------+
 *     | spawn |
 *     +---+---+
 *         |
 *         v
 *     +-------+  tool_use    +-------+
 *     | WORK  | <----------- |  LLM  |
 *     +---+---+              +-------+
 *         |
 *         | stop_reason != tool_use
 *         v
 *     +--------+
 *     | IDLE   | poll every 5s for up to 60s
 *     +---+----+
 *         |
 *         +---> check inbox -> message? -> resume WORK
 *         |
 *         +---> scan .tasks/ -> unclaimed? -> claim -> resume WORK
 *         |
 *         +---> timeout (60s) -> shutdown
 *
 *     Identity re-injection after compression:
 *     messages = [identity_block, ...remaining...]
 *     "You are 'coder', role: backend, team: my-team"
 *
 * Key insight: "The agent finds work itself."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
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

const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;

const VALID_MSG_TYPES = [
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
];

// -- Request trackers --
const shutdownRequests: Record<string, { target?: string; from?: string; status: string }> = {};
const planRequests: Record<string, { from: string; plan: string; status: string }> = {};


// -- MessageBus: JSONL inbox per teammate --
class MessageBus {
  dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    mkdirSync(this.dir, { recursive: true });
  }

  send(sender: string, to: string, content: string,
       msgType: string = "message", extra?: Record<string, unknown>): string {
    if (!VALID_MSG_TYPES.includes(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${VALID_MSG_TYPES.join(", ")}`;
    }
    const msg: Record<string, unknown> = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
    };
    if (extra) Object.assign(msg, extra);
    const inboxPath = join(this.dir, `${to}.jsonl`);
    appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Record<string, unknown>[] {
    const inboxPath = join(this.dir, `${name}.jsonl`);
    if (!existsSync(inboxPath)) return [];
    const text = readFileSync(inboxPath, "utf-8").trim();
    const messages: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (line) messages.push(JSON.parse(line));
    }
    writeFileSync(inboxPath, "");
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);


// -- Task board scanning --
interface TaskFile {
  id: number;
  subject: string;
  description?: string;
  status: string;
  owner?: string;
  blockedBy?: number[];
}

function scanUnclaimedTasks(): TaskFile[] {
  mkdirSync(TASKS_DIR, { recursive: true });
  const unclaimed: TaskFile[] = [];
  const files = readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();
  for (const f of files) {
    const task: TaskFile = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8"));
    if (task.status === "pending" && !task.owner && (!task.blockedBy || task.blockedBy.length === 0)) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}

function claimTask(taskId: number, owner: string): string {
  const path = join(TASKS_DIR, `task_${taskId}.json`);
  if (!existsSync(path)) return `Error: Task ${taskId} not found`;
  const task: TaskFile = JSON.parse(readFileSync(path, "utf-8"));
  task.owner = owner;
  task.status = "in_progress";
  writeFileSync(path, JSON.stringify(task, null, 2));
  return `Claimed task #${taskId} for ${owner}`;
}


// -- Identity re-injection after compression --
function makeIdentityBlock(name: string, role: string, teamName: string): Anthropic.Messages.MessageParam {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}


// -- Autonomous TeammateManager --
interface MemberConfig { name: string; role: string; status: string }
interface TeamConfig { team_name: string; members: MemberConfig[] }

class TeammateManager {
  dir: string;
  configPath: string;
  config: TeamConfig;

  constructor(teamDir: string) {
    this.dir = teamDir;
    mkdirSync(this.dir, { recursive: true });
    this.configPath = join(this.dir, "config.json");
    this.config = this._loadConfig();
  }

  _loadConfig(): TeamConfig {
    if (existsSync(this.configPath)) {
      return JSON.parse(readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  _saveConfig(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  _findMember(name: string): MemberConfig | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  _setStatus(name: string, status: string): void {
    const member = this._findMember(name);
    if (member) {
      member.status = status;
      this._saveConfig();
    }
  }

  spawn(name: string, role: string, prompt: string): string {
    let member = this._findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this._saveConfig();
    // Fire-and-forget async teammate loop
    this._loop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  async _loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt =
      `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. ` +
      `Use idle tool when you have no more work. You will auto-claim new tasks.`;
    const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this._teammateTools();

    while (true) {
      // -- WORK PHASE: standard agent loop --
      for (let i = 0; i < 50; i++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            this._setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }
        let response: Anthropic.Messages.Message;
        try {
          response = await client.messages.create({
            model: MODEL, system: sysPrompt, messages, tools, max_tokens: 8000,
          });
        } catch {
          this._setStatus(name, "idle");
          return;
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
              output = "Entering idle phase. Will poll for new tasks.";
            } else {
              output = this._exec(name, block.name, block.input as Record<string, unknown>);
            }
            console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
            results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          }
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) break;
      }

      // -- IDLE PHASE: poll for inbox messages and unclaimed tasks --
      this._setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));

      for (let p = 0; p < polls; p++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));

        const inbox = BUS.readInbox(name);
        if (inbox.length > 0) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this._setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }

        const unclaimed = scanUnclaimedTasks();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          claimTask(task.id, name);
          const taskPrompt =
            `<auto-claimed>Task #${task.id}: ${task.subject}\n` +
            `${task.description || ""}</auto-claimed>`;
          if (messages.length <= 3) {
            messages.unshift(makeIdentityBlock(name, role, teamName));
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }
          messages.push({ role: "user", content: taskPrompt });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }

      if (!resume) {
        this._setStatus(name, "shutdown");
        return;
      }
      this._setStatus(name, "working");
    }
  }

  _exec(sender: string, toolName: string, args: Record<string, unknown>): string {
    if (toolName === "bash") return runBash(args.command as string);
    if (toolName === "read_file") return runRead(args.path as string);
    if (toolName === "write_file") return runWrite(args.path as string, args.content as string);
    if (toolName === "edit_file") return runEdit(args.path as string, args.old_text as string, args.new_text as string);
    if (toolName === "send_message") return BUS.send(sender, args.to as string, args.content as string, (args.msg_type as string) || "message");
    if (toolName === "read_inbox") return JSON.stringify(BUS.readInbox(sender), null, 2);
    if (toolName === "shutdown_response") {
      const reqId = args.request_id as string;
      const approve = args.approve as boolean;
      if (reqId in shutdownRequests) {
        shutdownRequests[reqId].status = approve ? "approved" : "rejected";
      }
      BUS.send(
        sender, "lead", (args.reason as string) || "",
        "shutdown_response", { request_id: reqId, approve },
      );
      return `Shutdown ${approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") {
      const planText = (args.plan as string) || "";
      const reqId = randomUUID().slice(0, 8);
      planRequests[reqId] = { from: sender, plan: planText, status: "pending" };
      BUS.send(
        sender, "lead", planText, "plan_approval_response",
        { request_id: reqId, plan: planText },
      );
      return `Plan submitted (request_id=${reqId}). Waiting for approval.`;
    }
    if (toolName === "claim_task") return claimTask(args.task_id as number, sender);
    return `Unknown tool: ${toolName}`;
  }

  _teammateTools(): Anthropic.Messages.Tool[] {
    return [
      { name: "bash", description: "Run a shell command.",
        input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "Read file contents.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "Write content to file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Replace exact text in file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "Send message to a teammate.",
        input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: VALID_MSG_TYPES } }, required: ["to", "content"] } },
      { name: "read_inbox", description: "Read and drain your inbox.",
        input_schema: { type: "object" as const, properties: {} } },
      { name: "shutdown_response", description: "Respond to a shutdown request.",
        input_schema: { type: "object" as const, properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] } },
      { name: "plan_approval", description: "Submit a plan for lead approval.",
        input_schema: { type: "object" as const, properties: { plan: { type: "string" } }, required: ["plan"] } },
      { name: "idle", description: "Signal that you have no more work. Enters idle polling phase.",
        input_schema: { type: "object" as const, properties: {} } },
      { name: "claim_task", description: "Claim a task from the task board by ID.",
        input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    ];
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

const TEAM = new TeammateManager(TEAM_DIR);


// -- Base tool implementations --
function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
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


// -- Lead-specific protocol handlers --
function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send(
    "lead", teammate, "Please shut down gracefully.",
    "shutdown_request", { request_id: reqId },
  );
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send(
    "lead", req.from, feedback, "plan_approval_response",
    { request_id: requestId, approve, feedback },
  );
  return `Plan ${req.status} for '${req.from}'`;
}

function checkShutdownStatus(requestId: string): string {
  return JSON.stringify(shutdownRequests[requestId] || { error: "not found" });
}


// -- Lead tool dispatch (14 tools) --
type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:              (input) => runBash(input.command as string),
  read_file:         (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file:        (input) => runWrite(input.path as string, input.content as string),
  edit_file:         (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  spawn_teammate:    (input) => TEAM.spawn(input.name as string, input.role as string, input.prompt as string),
  list_teammates:    () => TEAM.listAll(),
  send_message:      (input) => BUS.send("lead", input.to as string, input.content as string, (input.msg_type as string) || "message"),
  read_inbox:        () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:         (input) => BUS.broadcast("lead", input.content as string, TEAM.memberNames()),
  shutdown_request:  (input) => handleShutdownRequest(input.teammate as string),
  shutdown_response: (input) => checkShutdownStatus((input.request_id as string) || ""),
  plan_approval:     (input) => handlePlanReview(input.request_id as string, input.approve as boolean, (input.feedback as string) || ""),
  idle:              () => "Lead does not idle.",
  claim_task:        (input) => claimTask(input.task_id as number, "lead"),
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
  { name: "spawn_teammate", description: "Spawn an autonomous teammate.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.",
    input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: VALID_MSG_TYPES } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.",
    input_schema: { type: "object" as const, properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down.",
    input_schema: { type: "object" as const, properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "shutdown_response", description: "Check shutdown request status.",
    input_schema: { type: "object" as const, properties: { request_id: { type: "string" } }, required: ["request_id"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan.",
    input_schema: { type: "object" as const, properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle", description: "Enter idle state (for lead -- rarely used).",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "claim_task", description: "Claim a task from the board by ID.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];


async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted inbox messages.",
      });
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
const history: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const prompt = (): void => {
  rl.question("\x1b[36ms11 >> \x1b[0m", async (query) => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed || trimmed === "q" || trimmed === "exit") { rl.close(); return; }
    if (query.trim() === "/team") {
      console.log(TEAM.listAll());
      prompt();
      return;
    }
    if (query.trim() === "/inbox") {
      console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      prompt();
      return;
    }
    if (query.trim() === "/tasks") {
      mkdirSync(TASKS_DIR, { recursive: true });
      const files = readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json")).sort();
      for (const f of files) {
        const t: TaskFile = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8"));
        const marker: Record<string, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
        const owner = t.owner ? ` @${t.owner}` : "";
        console.log(`  ${marker[t.status] || "[?]"} #${t.id}: ${t.subject}${owner}`);
      }
      prompt();
      return;
    }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    const last = history[history.length - 1];
    if (last.role === "assistant" && Array.isArray(last.content)) {
      for (const block of last.content) {
        if ((block as Anthropic.Messages.TextBlock).type === "text") {
          console.log((block as Anthropic.Messages.TextBlock).text);
        }
      }
    }
    console.log();
    prompt();
  });
};

prompt();
