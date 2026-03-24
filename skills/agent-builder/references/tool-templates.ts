/**
 * Tool Templates - Copy and customize these for your agent.
 *
 * Each tool needs:
 * 1. Definition (JSON schema for the model)
 * 2. Implementation (TypeScript function)
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const WORKDIR = process.cwd();

// =============================================================================
// TOOL DEFINITIONS (for TOOLS list)
// =============================================================================

const BASH_TOOL: Anthropic.Messages.Tool = {
  name: "bash",
  description: "Run a shell command. Use for: ls, find, grep, git, npm, etc.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
    },
    required: ["command"],
  },
};

const READ_FILE_TOOL: Anthropic.Messages.Tool = {
  name: "read_file",
  description: "Read file contents. Returns UTF-8 text.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file",
      },
      limit: {
        type: "integer",
        description: "Max lines to read (default: all)",
      },
    },
    required: ["path"],
  },
};

const WRITE_FILE_TOOL: Anthropic.Messages.Tool = {
  name: "write_file",
  description: "Write content to a file. Creates parent directories if needed.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Relative path for the file",
      },
      content: {
        type: "string",
        description: "Content to write",
      },
    },
    required: ["path", "content"],
  },
};

const EDIT_FILE_TOOL: Anthropic.Messages.Tool = {
  name: "edit_file",
  description: "Replace exact text in a file. Use for surgical edits.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file",
      },
      old_text: {
        type: "string",
        description: "Exact text to find (must match precisely)",
      },
      new_text: {
        type: "string",
        description: "Replacement text",
      },
    },
    required: ["path", "old_text", "new_text"],
  },
};

const TODO_WRITE_TOOL: Anthropic.Messages.Tool = {
  name: "TodoWrite",
  description: "Update the task list. Use to plan and track progress.",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        description: "Complete list of tasks",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Task description" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
            activeForm: {
              type: "string",
              description: "Present tense, e.g. 'Reading files'",
            },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["items"],
  },
};

// Generate TASK_TOOL dynamically with agent types:
//
// const TASK_TOOL: Anthropic.Messages.Tool = {
//   name: "Task",
//   description: `Spawn a subagent for a focused subtask.\n\nAgent types:\n${getAgentDescriptions()}`,
//   input_schema: {
//     type: "object" as const,
//     properties: {
//       description: { type: "string", description: "Short task name (3-5 words)" },
//       prompt: { type: "string", description: "Detailed instructions" },
//       agent_type: { type: "string", enum: Object.keys(AGENT_TYPES) },
//     },
//     required: ["description", "prompt", "agent_type"],
//   },
// };

// =============================================================================
// TOOL IMPLEMENTATIONS
// =============================================================================

/**
 * Security: Ensure path stays within workspace.
 * Prevents ../../../etc/passwd attacks.
 */
function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/**
 * Execute shell command with safety checks.
 *
 * Safety features:
 * - Blocks obviously dangerous commands
 * - 60 second timeout
 * - Output truncated to 50KB
 */
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const stdout = execSync(command, {
      cwd: WORKDIR,
      shell: "/bin/sh",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = (stdout ?? "").trim();
    return output ? output.slice(0, 50_000) : "(no output)";
  } catch (err: unknown) {
    if (err && typeof err === "object" && "killed" in err && err.killed) {
      return "Error: Command timed out (60s)";
    }
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
    return out ? out.slice(0, 50_000) : `Error: ${e.message}`;
  }
}

/**
 * Read file contents with optional line limit.
 *
 * Features:
 * - Safe path resolution
 * - Optional line limit for large files
 * - Output truncated to 50KB
 */
function runReadFile(path: string, limit?: number): string {
  try {
    const text = readFileSync(safePath(path), "utf-8");
    let lines = text.split("\n");

    if (limit && limit < lines.length) {
      lines = [
        ...lines.slice(0, limit),
        `... (${lines.length - limit} more lines)`,
      ];
    }

    return lines.join("\n").slice(0, 50_000);
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * Write content to file, creating parent directories if needed.
 *
 * Features:
 * - Safe path resolution
 * - Auto-creates parent directories
 * - Returns byte count for confirmation
 */
function runWriteFile(path: string, content: string): string {
  try {
    const fp = safePath(path);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

/**
 * Replace exact text in a file (surgical edit).
 *
 * Features:
 * - Exact string matching (not regex)
 * - Only replaces first occurrence (safety)
 * - Clear error if text not found
 */
function runEditFile(path: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(path);
    const content = readFileSync(fp, "utf-8");

    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }

    const newContent = content.replace(oldText, newText);
    writeFileSync(fp, newContent);
    return `Edited ${path}`;
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

// =============================================================================
// DISPATCHER PATTERN
// =============================================================================

type ToolInput = Record<string, unknown>;

/**
 * Dispatch tool call to implementation.
 *
 * This pattern makes it easy to add new tools:
 * 1. Add definition to TOOLS list
 * 2. Add implementation function
 * 3. Add case to this dispatcher
 */
function executeTool(name: string, args: ToolInput): string {
  if (name === "bash") {
    return runBash(args.command as string);
  }
  if (name === "read_file") {
    return runReadFile(args.path as string, args.limit as number | undefined);
  }
  if (name === "write_file") {
    return runWriteFile(args.path as string, args.content as string);
  }
  if (name === "edit_file") {
    return runEditFile(
      args.path as string,
      args.old_text as string,
      args.new_text as string
    );
  }
  // Add more tools here...
  return `Unknown tool: ${name}`;
}

export {
  BASH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  TODO_WRITE_TOOL,
  safePath,
  runBash,
  runReadFile,
  runWriteFile,
  runEditFile,
  executeTool,
};
