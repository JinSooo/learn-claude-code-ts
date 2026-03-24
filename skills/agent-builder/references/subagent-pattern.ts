/**
 * Subagent Pattern - How to implement Task tool for context isolation.
 *
 * The key insight: spawn child agents with ISOLATED context to prevent
 * "context pollution" where exploration details fill up the main conversation.
 */

import Anthropic from "@anthropic-ai/sdk";

// Assuming client, MODEL, executeTool are defined elsewhere

// =============================================================================
// AGENT TYPE REGISTRY
// =============================================================================

interface AgentConfig {
  description: string;
  tools: string[] | "*";
  prompt: string;
}

const AGENT_TYPES: Record<string, AgentConfig> = {
  // Explore: Read-only, for searching and analyzing
  explore: {
    description: "Read-only agent for exploring code, finding files, searching",
    tools: ["bash", "read_file"], // No write access!
    prompt:
      "You are an exploration agent. Search and analyze, but NEVER modify files. Return a concise summary of what you found.",
  },

  // Code: Full-powered, for implementation
  code: {
    description: "Full agent for implementing features and fixing bugs",
    tools: "*", // All tools
    prompt:
      "You are a coding agent. Implement the requested changes efficiently. Return a summary of what you changed.",
  },

  // Plan: Read-only, for design work
  plan: {
    description: "Planning agent for designing implementation strategies",
    tools: ["bash", "read_file"], // Read-only
    prompt:
      "You are a planning agent. Analyze the codebase and output a numbered implementation plan. Do NOT make any changes.",
  },

  // Add your own types here...
  // test: {
  //   description: "Testing agent for running and analyzing tests",
  //   tools: ["bash", "read_file"],
  //   prompt: "Run tests and report results. Don't modify code.",
  // },
};

function getAgentDescriptions(): string {
  return Object.entries(AGENT_TYPES)
    .map(([name, cfg]) => `- ${name}: ${cfg.description}`)
    .join("\n");
}

function getToolsForAgent(
  agentType: string,
  baseTools: Anthropic.Messages.Tool[]
): Anthropic.Messages.Tool[] {
  /**
   * Filter tools based on agent type.
   *
   * '*' means all base tools.
   * Otherwise, whitelist specific tool names.
   *
   * Note: Subagents don't get Task tool to prevent infinite recursion.
   */
  const allowed = AGENT_TYPES[agentType]?.tools ?? "*";

  if (allowed === "*") {
    return baseTools; // All base tools, but NOT Task
  }

  return baseTools.filter((t) => (allowed as string[]).includes(t.name));
}

// =============================================================================
// TASK TOOL DEFINITION
// =============================================================================

const TASK_TOOL: Anthropic.Messages.Tool = {
  name: "Task",
  description: `Spawn a subagent for a focused subtask.

Subagents run in ISOLATED context - they don't see parent's history.
Use this to keep the main conversation clean.

Agent types:
${getAgentDescriptions()}

Example uses:
- Task(explore): "Find all files using the auth module"
- Task(plan): "Design a migration strategy for the database"
- Task(code): "Implement the user registration form"`,
  input_schema: {
    type: "object" as const,
    properties: {
      description: {
        type: "string",
        description: "Short task name (3-5 words) for progress display",
      },
      prompt: {
        type: "string",
        description: "Detailed instructions for the subagent",
      },
      agent_type: {
        type: "string",
        enum: Object.keys(AGENT_TYPES),
        description: "Type of agent to spawn",
      },
    },
    required: ["description", "prompt", "agent_type"],
  },
};

// =============================================================================
// SUBAGENT EXECUTION
// =============================================================================

type ToolInput = Record<string, unknown>;
type ExecuteToolFn = (name: string, args: ToolInput) => string;

/**
 * Execute a subagent task with isolated context.
 *
 * Key concepts:
 * 1. ISOLATED HISTORY - subagent starts fresh, no parent context
 * 2. FILTERED TOOLS - based on agent type permissions
 * 3. AGENT-SPECIFIC PROMPT - specialized behavior
 * 4. RETURNS SUMMARY ONLY - parent sees just the final result
 */
async function runTask(
  description: string,
  prompt: string,
  agentType: string,
  client: Anthropic,
  model: string,
  workdir: string,
  baseTools: Anthropic.Messages.Tool[],
  executeToolFn: ExecuteToolFn
): Promise<string> {
  if (!(agentType in AGENT_TYPES)) {
    return `Error: Unknown agent type '${agentType}'`;
  }

  const config = AGENT_TYPES[agentType];

  // Agent-specific system prompt
  const subSystem = `You are a ${agentType} subagent at ${workdir}.

${config.prompt}

Complete the task and return a clear, concise summary.`;

  // Filtered tools for this agent type
  const subTools = getToolsForAgent(agentType, baseTools);

  // KEY: ISOLATED message history!
  // The subagent starts fresh, doesn't see parent's conversation
  const subMessages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: prompt },
  ];

  // Progress display
  console.log(`  [${agentType}] ${description}`);
  const start = Date.now();
  let toolCount = 0;

  // Run the same agent loop (but silently)
  let response: Anthropic.Messages.Message;
  while (true) {
    response = await client.messages.create({
      model,
      system: subSystem,
      messages: subMessages,
      tools: subTools,
      max_tokens: 8000,
    });

    // Check if done
    if (response.stop_reason !== "tool_use") {
      break;
    }

    // Execute tools
    const toolCalls = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const tc of toolCalls) {
      toolCount++;
      const output = executeToolFn(tc.name, tc.input as ToolInput);
      results.push({
        type: "tool_result",
        tool_use_id: tc.id,
        content: output,
      });

      // Update progress (in-place on same line)
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(
        `\r  [${agentType}] ${description} ... ${toolCount} tools, ${elapsed}s`
      );
    }

    subMessages.push({ role: "assistant", content: response.content });
    subMessages.push({ role: "user", content: results });
  }

  // Final progress update
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write(
    `\r  [${agentType}] ${description} - done (${toolCount} tools, ${elapsed}s)\n`
  );

  // Extract and return ONLY the final text
  // This is what the parent agent sees - a clean summary
  for (const block of response!.content) {
    if (block.type === "text") {
      return block.text;
    }
  }

  return "(subagent returned no text)";
}

export { AGENT_TYPES, TASK_TOOL, getAgentDescriptions, getToolsForAgent, runTask };
export type { AgentConfig, ExecuteToolFn };

// =============================================================================
// USAGE EXAMPLE
// =============================================================================

/*
// In your main agent's executeTool function:

function executeTool(name: string, args: ToolInput): string | Promise<string> {
  if (name === "Task") {
    return runTask(
      args.description as string,
      args.prompt as string,
      args.agent_type as string,
      client,
      MODEL,
      WORKDIR,
      BASE_TOOLS,
      executeTool  // Pass self for recursion
    );
  }
  // ... other tools ...
}


// In your TOOLS list:
const TOOLS = [...BASE_TOOLS, TASK_TOOL];
*/
