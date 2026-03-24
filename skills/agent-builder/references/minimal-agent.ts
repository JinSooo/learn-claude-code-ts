/**
 * Minimal Agent Template - Copy and customize this.
 *
 * This is the simplest possible working agent (~80 lines).
 * It has everything you need: 3 tools + loop.
 *
 * Usage:
 *    1. Set ANTHROPIC_API_KEY environment variable
 *    2. bun run minimal-agent.ts
 *    3. Type commands, 'q' to quit
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";

// Configuration
const client = new Anthropic();
const MODEL = process.env.MODEL_NAME ?? "claude-sonnet-4-20250514";
const WORKDIR = process.cwd();

// System prompt - keep it simple
const SYSTEM = `You are a coding agent at ${WORKDIR}.

Rules:
- Use tools to complete tasks
- Prefer action over explanation
- Summarize what you did when done`;

// Minimal tool set - add more as needed
const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "bash",
    description: "Run shell command",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
];

type ToolInput = Record<string, unknown>;

function executeTool(name: string, args: ToolInput): string {
  if (name === "bash") {
    try {
      const stdout = execSync(args.command as string, {
        cwd: WORKDIR,
        shell: "/bin/sh",
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out = (stdout ?? "").trim();
      return out || "(empty)";
    } catch (err: unknown) {
      if (err && typeof err === "object" && "killed" in err && err.killed) {
        return "Error: Timeout";
      }
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
      return out || `Error: ${e.message}`;
    }
  }

  if (name === "read_file") {
    try {
      return readFileSync(resolve(WORKDIR, args.path as string), "utf-8").slice(0, 50_000);
    } catch (e: unknown) {
      return `Error: ${e instanceof Error ? e.message : e}`;
    }
  }

  if (name === "write_file") {
    try {
      const p = resolve(WORKDIR, args.path as string);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, args.content as string);
      return `Wrote ${(args.content as string).length} bytes to ${args.path}`;
    } catch (e: unknown) {
      return `Error: ${e instanceof Error ? e.message : e}`;
    }
  }

  return `Unknown tool: ${name}`;
}

async function agent(prompt: string, history: Anthropic.Messages.MessageParam[]): Promise<string> {
  history.push({ role: "user", content: prompt });

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: history,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // Build assistant message
    history.push({ role: "assistant", content: response.content });

    // If no tool calls, return text
    if (response.stop_reason !== "tool_use") {
      return response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    }

    // Execute tools
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`> ${block.name}: ${JSON.stringify(block.input)}`);
        const output = executeTool(block.name, block.input as ToolInput);
        console.log(`  ${output.slice(0, 100)}...`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    history.push({ role: "user", content: results });
  }
}

// -- Interactive REPL --
console.log(`Minimal Agent - ${WORKDIR}`);
console.log("Type 'q' to quit.\n");

const history: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const promptUser = (): void => {
  rl.question(">> ", async (query) => {
    const trimmed = query.trim();
    if (!trimmed || ["q", "quit", "exit"].includes(trimmed.toLowerCase())) {
      rl.close();
      return;
    }
    const result = await agent(trimmed, history);
    console.log(result);
    console.log();
    promptUser();
  });
};

promptUser();
