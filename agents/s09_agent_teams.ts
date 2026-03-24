/**
 * s09_agent_teams.ts - Agent Teams
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate thread. Communication via append-only inboxes.
 *
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s09):  spawn -> work -> idle -> work -> ... -> shutdown
 *
 *     .team/config.json                   .team/inbox/
 *     +----------------------------+      +------------------+
 *     | {"team_name": "default",   |      | alice.jsonl      |
 *     |  "members": [              |      | bob.jsonl        |
 *     |    {"name":"alice",        |      | lead.jsonl       |
 *     |     "role":"coder",        |      +------------------+
 *     |     "status":"idle"}       |
 *     |  ]}                        |      send_message("alice", "fix bug"):
 *     +----------------------------+        open("alice.jsonl", "a").write(msg)
 *
 *                                         read_inbox("alice"):
 *     spawn_teammate("alice","coder",...)   msgs = [json.loads(l) for l in ...]
 *          |                                open("alice.jsonl", "w").close()
 *          v                                return msgs  // drain
 *     Async: alice              Async: bob
 *     +------------------+      +------------------+
 *     | agent_loop       |      | agent_loop       |
 *     | status: working  |      | status: idle     |
 *     | ... runs tools   |      | ... waits ...    |
 *     | status -> idle   |      |                  |
 *     +------------------+      +------------------+
 *
 *     5 message types (all declared, not all handled here):
 *     +-------------------------+-----------------------------------+
 *     | message                 | Normal text message               |
 *     | broadcast               | Sent to all teammates             |
 *     | shutdown_request        | Request graceful shutdown (s10)   |
 *     | shutdown_response       | Approve/reject shutdown (s10)     |
 *     | plan_approval_response  | Approve/reject plan (s10)         |
 *     +-------------------------+-----------------------------------+
 *
 * Key insight: "Teammates that can talk to each other."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
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
const TEAM_DIR = join(WORKDIR, ".team");
const INBOX_DIR = join(TEAM_DIR, "inbox");

const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

const VALID_MSG_TYPES = [
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
];


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


// -- TeammateManager: persistent named agents with config.json --
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
    this._teammateLoop(name, role, prompt);
    return `Spawned '${name}' (role: ${role})`;
  }

  async _teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const sysPrompt =
      `You are '${name}', role: ${role}, at ${WORKDIR}. ` +
      `Use send_message to communicate. Complete your task.`;
    const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this._teammateTools();

    for (let i = 0; i < 50; i++) {
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }
      let response: Anthropic.Messages.Message;
      try {
        response = await client.messages.create({
          model: MODEL, system: sysPrompt, messages, tools, max_tokens: 8000,
        });
      } catch {
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason !== "tool_use") break;

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = this._exec(name, block.name, block.input as Record<string, unknown>);
          console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
        }
      }
      messages.push({ role: "user", content: results });
    }

    const member = this._findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this._saveConfig();
    }
  }

  _exec(sender: string, toolName: string, args: Record<string, unknown>): string {
    if (toolName === "bash") return runBash(args.command as string);
    if (toolName === "read_file") return runRead(args.path as string);
    if (toolName === "write_file") return runWrite(args.path as string, args.content as string);
    if (toolName === "edit_file") return runEdit(args.path as string, args.old_text as string, args.new_text as string);
    if (toolName === "send_message") return BUS.send(sender, args.to as string, args.content as string, (args.msg_type as string) || "message");
    if (toolName === "read_inbox") return JSON.stringify(BUS.readInbox(sender), null, 2);
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


// -- Lead tool dispatch (9 tools) --
type ToolInput = Record<string, unknown>;
type ToolHandler = (input: ToolInput) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash:            (input) => runBash(input.command as string),
  read_file:       (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file:      (input) => runWrite(input.path as string, input.content as string),
  edit_file:       (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  spawn_teammate:  (input) => TEAM.spawn(input.name as string, input.role as string, input.prompt as string),
  list_teammates:  () => TEAM.listAll(),
  send_message:    (input) => BUS.send("lead", input.to as string, input.content as string, (input.msg_type as string) || "message"),
  read_inbox:      () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast:       (input) => BUS.broadcast("lead", input.content as string, TEAM.memberNames()),
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
  { name: "spawn_teammate", description: "Spawn a persistent teammate that runs in its own thread.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates with name, role, status.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "send_message", description: "Send a message to a teammate's inbox.",
    input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: VALID_MSG_TYPES } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.",
    input_schema: { type: "object" as const, properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.",
    input_schema: { type: "object" as const, properties: { content: { type: "string" } }, required: ["content"] } },
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
  rl.question("\x1b[36ms09 >> \x1b[0m", async (query) => {
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
