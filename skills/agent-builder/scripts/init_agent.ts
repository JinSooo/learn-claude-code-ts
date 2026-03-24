#!/usr/bin/env bun
/**
 * Agent Scaffold Script - Create a new agent project with best practices.
 *
 * Usage:
 *    bun run init_agent.ts <agent-name> [--level 0-4] [--path <output-dir>]
 *
 * Examples:
 *    bun run init_agent.ts my-agent                 # Level 1 (4 tools)
 *    bun run init_agent.ts my-agent --level 0      # Minimal (bash only)
 *    bun run init_agent.ts my-agent --level 2      # With TodoWrite
 *    bun run init_agent.ts my-agent --path ./bots  # Custom output directory
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Agent templates for each level - these generate TypeScript agent files
const TEMPLATES: Record<number, (name: string) => string> = {
  0: (name: string) => `#!/usr/bin/env bun
/**
 * Level 0 Agent - Bash is All You Need (~50 lines)
 *
 * Core insight: One tool (bash) can do everything.
 * Subagents via self-recursion: bun run ${name}.ts "subtask"
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

const client = new Anthropic();
const MODEL = process.env.MODEL_NAME ?? "claude-sonnet-4-20250514";

const SYSTEM = \`You are a coding agent. Use bash for everything:
- Read: cat, grep, find, ls
- Write: echo 'content' > file
- Subagent: bun run ${name}.ts "subtask"\`;

const TOOL: Anthropic.Messages.Tool[] = [{
  name: "bash",
  description: "Execute shell command",
  input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] },
}];

type ToolInput = Record<string, unknown>;

async function run(prompt: string, history: Anthropic.Messages.MessageParam[] = []): Promise<string> {
  history.push({ role: "user", content: prompt });
  while (true) {
    const r = await client.messages.create({ model: MODEL, system: SYSTEM, messages: history, tools: TOOL, max_tokens: 8000 });
    history.push({ role: "assistant", content: r.content });
    if (r.stop_reason !== "tool_use") {
      return r.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map((b) => b.text).join("");
    }
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const b of r.content) {
      if (b.type === "tool_use") {
        const input = b.input as ToolInput;
        console.log(\`> \${input.command}\`);
        let output: string;
        try {
          const stdout = execSync(input.command as string, { shell: "/bin/sh", timeout: 60_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
          output = (stdout ?? "").trim() || "(empty)";
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string; message?: string };
          output = ((err.stdout ?? "") + (err.stderr ?? "")).trim() || \`Error: \${err.message}\`;
        }
        results.push({ type: "tool_result", tool_use_id: b.id, content: output.slice(0, 50_000) });
      }
    }
    history.push({ role: "user", content: results });
  }
}

const h: Anthropic.Messages.MessageParam[] = [];
console.log("${name} - Level 0 Agent\\nType 'q' to quit.\\n");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const promptUser = (): void => {
  rl.question(">> ", async (q) => {
    const trimmed = q.trim();
    if (!trimmed || ["q", "quit"].includes(trimmed.toLowerCase())) { rl.close(); return; }
    console.log(await run(trimmed, h), "\\n");
    promptUser();
  });
};
promptUser();
`,

  1: (name: string) => `#!/usr/bin/env bun
/**
 * Level 1 Agent - Model as Agent (~200 lines)
 *
 * Core insight: 4 tools cover 90% of coding tasks.
 * The model IS the agent. Code just runs the loop.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";

const client = new Anthropic();
const MODEL = process.env.MODEL_NAME ?? "claude-sonnet-4-20250514";
const WORKDIR = process.cwd();

const SYSTEM = \`You are a coding agent at \${WORKDIR}.

Rules:
- Prefer tools over prose. Act, don't just explain.
- Never invent file paths. Use ls/find first if unsure.
- Make minimal changes. Don't over-engineer.
- After finishing, summarize what changed.\`;

const TOOLS: Anthropic.Messages.Tool[] = [
  { name: "bash", description: "Run shell command",
    input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents",
    input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file",
    input_schema: { type: "object" as const, properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
];

type ToolInput = Record<string, unknown>;

function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(\`Path escapes workspace: \${p}\`);
  return resolved;
}

function execute(toolName: string, args: ToolInput): string {
  if (toolName === "bash") {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "> /dev/"];
    if (dangerous.some((d) => (args.command as string).includes(d))) return "Error: Dangerous command blocked";
    try {
      const stdout = execSync(args.command as string, { cwd: WORKDIR, shell: "/bin/sh", timeout: 60_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      return ((stdout ?? "").trim()).slice(0, 50_000) || "(empty)";
    } catch (err: unknown) {
      if (err && typeof err === "object" && "killed" in err && err.killed) return "Error: Timeout (60s)";
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
      return out ? out.slice(0, 50_000) : \`Error: \${e.message}\`;
    }
  }

  if (toolName === "read_file") {
    try { return readFileSync(safePath(args.path as string), "utf-8").slice(0, 50_000); }
    catch (e: unknown) { return \`Error: \${e instanceof Error ? e.message : e}\`; }
  }

  if (toolName === "write_file") {
    try {
      const p = safePath(args.path as string);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, args.content as string);
      return \`Wrote \${(args.content as string).length} bytes to \${args.path}\`;
    } catch (e: unknown) { return \`Error: \${e instanceof Error ? e.message : e}\`; }
  }

  if (toolName === "edit_file") {
    try {
      const p = safePath(args.path as string);
      const content = readFileSync(p, "utf-8");
      if (!(content.includes(args.old_text as string))) return \`Error: Text not found in \${args.path}\`;
      writeFileSync(p, content.replace(args.old_text as string, args.new_text as string));
      return \`Edited \${args.path}\`;
    } catch (e: unknown) { return \`Error: \${e instanceof Error ? e.message : e}\`; }
  }

  return \`Unknown tool: \${toolName}\`;
}

async function agent(prompt: string, history: Anthropic.Messages.MessageParam[]): Promise<string> {
  history.push({ role: "user", content: prompt });

  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages: history, tools: TOOLS, max_tokens: 8000 });
    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return response.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map((b) => b.text).join("");
    }

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(\`> \${block.name}: \${JSON.stringify(block.input).slice(0, 100)}\`);
        const output = execute(block.name, block.input as ToolInput);
        console.log(\`  \${output.slice(0, 100)}...\`);
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    history.push({ role: "user", content: results });
  }
}

console.log(\`${name} - Level 1 Agent at \${WORKDIR}\`);
console.log("Type 'q' to quit.\\n");
const h: Anthropic.Messages.MessageParam[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });
const promptUser = (): void => {
  rl.question(">> ", async (query) => {
    const trimmed = query.trim();
    if (!trimmed || ["q", "quit", "exit"].includes(trimmed.toLowerCase())) { rl.close(); return; }
    console.log(await agent(trimmed, h), "\\n");
    promptUser();
  });
};
promptUser();
`,
};

const ENV_TEMPLATE = `# API Configuration
ANTHROPIC_API_KEY=sk-xxx
MODEL_NAME=claude-sonnet-4-20250514
`;

function createAgent(name: string, level: number, outputDir: string): void {
  // Validate level
  if (!(level in TEMPLATES) && ![2, 3, 4].includes(level)) {
    console.error(`Error: Level ${level} not yet implemented in scaffold.`);
    console.error("Available levels: 0 (minimal), 1 (4 tools)");
    console.error("For levels 2-4, copy from mini-claude-code repository.");
    process.exit(1);
  }

  // Create output directory
  const agentDir = resolve(outputDir, name);
  mkdirSync(agentDir, { recursive: true });

  // Write agent file
  const agentFile = join(agentDir, `${name}.ts`);
  const template = TEMPLATES[level] ?? TEMPLATES[1];
  writeFileSync(agentFile, template(name));
  console.log(`Created: ${agentFile}`);

  // Write .env.example
  const envFile = join(agentDir, ".env.example");
  writeFileSync(envFile, ENV_TEMPLATE);
  console.log(`Created: ${envFile}`);

  // Write .gitignore
  const gitignore = join(agentDir, ".gitignore");
  writeFileSync(gitignore, ".env\nnode_modules/\n");
  console.log(`Created: ${gitignore}`);

  // Write package.json
  const pkgJson = join(agentDir, "package.json");
  writeFileSync(
    pkgJson,
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: { start: `bun run ${name}.ts` },
        dependencies: { "@anthropic-ai/sdk": "^0.39.0" },
      },
      null,
      2
    ) + "\n"
  );
  console.log(`Created: ${pkgJson}`);

  console.log(`\nAgent '${name}' created at ${agentDir}`);
  console.log(`\nNext steps:`);
  console.log(`  1. cd ${agentDir}`);
  console.log(`  2. cp .env.example .env`);
  console.log(`  3. Edit .env with your API key`);
  console.log(`  4. bun install`);
  console.log(`  5. bun run ${name}.ts`);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Agent Scaffold Script - Create a new agent project with best practices.

Usage:
    bun run init_agent.ts <agent-name> [--level 0-4] [--path <output-dir>]

Levels:
  0  Minimal (~50 lines) - Single bash tool, self-recursion for subagents
  1  Basic (~200 lines)  - 4 core tools: bash, read, write, edit
  2  Todo (~300 lines)   - + TodoWrite for structured planning
  3  Subagent (~450)     - + Task tool for context isolation
  4  Skills (~550)       - + Skill tool for domain expertise

Examples:
    bun run init_agent.ts my-agent                 # Level 1 (4 tools)
    bun run init_agent.ts my-agent --level 0      # Minimal (bash only)
    bun run init_agent.ts my-agent --path ./bots  # Custom output directory
`);
    process.exit(0);
  }

  const name = args[0];
  let level = 1;
  let outputPath = process.cwd();

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--level" && args[i + 1]) {
      level = parseInt(args[++i], 10);
      if (![0, 1, 2, 3, 4].includes(level)) {
        console.error(`Error: Level must be 0-4, got ${level}`);
        process.exit(1);
      }
    } else if (args[i] === "--path" && args[i + 1]) {
      outputPath = resolve(args[++i]);
    }
  }

  createAgent(name, level, outputPath);
}

main();
