/**
 * s06_context_compact.ts - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *     Every turn:
 *     [Layer 1: microCompact]        (silent, every turn)
 *       Replace tool_result content older than last 3
 *       with "[Previous: used {tool_name}]"
 *
 *     [Check: tokens > 50000?]
 *       no -> continue
 *       yes -> [Layer 2: autoCompact]
 *                Save full transcript to .transcripts/
 *                Ask LLM to summarize conversation.
 *                Replace all messages with [summary].
 *
 *     [Layer 3: compact tool]
 *       Model calls compact -> immediate summarization.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50_000;
const TRANSCRIPT_DIR = join(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;

function estimateTokens(messages: Anthropic.Messages.MessageParam[]): number {
  return JSON.stringify(messages).length / 4;
}

// -- Layer 1: microCompact - replace old tool results with placeholders --
function microCompact(messages: Anthropic.Messages.MessageParam[]): void {
  const toolResults: Array<{ msgIdx: number; partIdx: number; part: Record<string, unknown> }> = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx] as unknown as Record<string, unknown>;
        if (part && typeof part === "object" && part.type === "tool_result") {
          toolResults.push({ msgIdx, partIdx, part });
        }
      }
    }
  }
  if (toolResults.length <= KEEP_RECENT) return;

  // Build tool_use_id -> tool_name map from assistant messages
  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") toolNameMap[block.id] = block.name;
      }
    }
  }

  const toClear = toolResults.slice(0, -KEEP_RECENT);
  for (const { part } of toClear) {
    if (typeof part.content === "string" && part.content.length > 100) {
      const toolName = toolNameMap[part.tool_use_id as string] || "unknown";
      part.content = `[Previous: used ${toolName}]`;
    }
  }
}

// -- Layer 2: autoCompact - save transcript, summarize, replace messages --
async function autoCompact(messages: Anthropic.Messages.MessageParam[]): Promise<Anthropic.Messages.MessageParam[]> {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  for (const msg of messages) {
    appendFileSync(transcriptPath, JSON.stringify(msg, (_key, value) => typeof value === "bigint" ? String(value) : value) + "\n");
  }
  console.log(`[transcript saved: ${transcriptPath}]`);

  const conversationText = JSON.stringify(messages).slice(0, 80_000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content:
      "Summarize this conversation for continuity. Include: " +
      "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
      "Be concise but preserve critical details.\n\n" + conversationText }],
    max_tokens: 2000,
  });
  const summary = response.content[0].type === "text" ? response.content[0].text : "";

  return [
    { role: "user", content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}` },
    { role: "assistant", content: "Understood. I have the context from the summary. Continuing." },
  ];
}

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
  bash:       (input) => runBash(input.command as string),
  read_file:  (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  edit_file:  (input) => runEdit(input.path as string, input.old_text as string, input.new_text as string),
  compact:    () => "Manual compression requested.",
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
  { name: "compact", description: "Trigger manual conversation compression.",
    input_schema: { type: "object" as const, properties: { focus: { type: "string", description: "What to preserve in the summary" } } } },
];

async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  while (true) {
    // Layer 1: microCompact before each LLM call
    microCompact(messages);
    // Layer 2: autoCompact if token estimate exceeds threshold
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    let manualCompact = false;
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;
        if (block.name === "compact") {
          manualCompact = true;
          output = "Compressing...";
        } else {
          const handler = TOOL_HANDLERS[block.name];
          try { output = handler ? handler(block.input as ToolInput) : `Unknown tool: ${block.name}`; }
          catch (e: unknown) { output = `Error: ${e instanceof Error ? e.message : e}`; }
        }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
      }
    }
    messages.push({ role: "user", content: results });

    // Layer 3: manual compact triggered by the compact tool
    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

// -- Interactive REPL --
const history: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const prompt = (): void => {
  rl.question("\x1b[36ms06 >> \x1b[0m", async (query) => {
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
