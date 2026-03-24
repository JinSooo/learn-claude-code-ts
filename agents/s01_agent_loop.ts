/**
 * s01_agent_loop.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while (stopReason === "tool_use") {
 *       response = LLM(messages, tools)
 *       execute tools
 *       append results
 *     }
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                            ^               |
 *                            |   tool_result |
 *                            +---------------+
 *                            (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

// Bun loads .env natively; Node needs dotenv
if (typeof (globalThis as Record<string, unknown>).Bun === "undefined") {
  const { config } = await import("dotenv");
  config({ override: true });
}

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const stdout = execSync(command, {
      cwd: process.cwd(),
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

// -- The core pattern: a while loop that calls tools until the model stops --
async function agentLoop(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // Append assistant turn
    messages.push({ role: "assistant", content: response.content });

    // If the model didn't call a tool, we're done
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // Execute each tool call, collect results
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const input = block.input as { command: string };
        console.log(`\x1b[33m$ ${input.command}\x1b[0m`);
        const output = runBash(input.command);
        console.log(output.slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

// -- Interactive REPL --
const history: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const prompt = (): void => {
  rl.question("\x1b[36ms01 >> \x1b[0m", async (query) => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed || trimmed === "q" || trimmed === "exit") {
      rl.close();
      return;
    }
    history.push({ role: "user", content: query });
    await agentLoop(history);

    // Print final assistant response
    const last = history[history.length - 1];
    if (last.role === "assistant" && Array.isArray(last.content)) {
      for (const block of last.content) {
        if (block.type === "text") {
          console.log(block.text);
        }
      }
    }
    console.log();
    prompt();
  });
};

prompt();
