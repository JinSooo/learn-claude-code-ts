# s05: Skills

`s01 > s02 > s03 > s04 > [ s05 ] s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"Load knowledge when you need it, not upfront"* -- inject via tool_result, not the system prompt.
>
> **Harness layer**: On-demand knowledge -- domain expertise, loaded when the model asks.

## Problem

You want the agent to follow domain-specific workflows: git conventions, testing patterns, code review checklists. Putting everything in the system prompt wastes tokens on unused skills. 10 skills at 2000 tokens each = 20,000 tokens, most of which are irrelevant to any given task.

## Solution

```
System prompt (Layer 1 -- always present):
+--------------------------------------+
| You are a coding agent.              |
| Skills available:                    |
|   - git: Git workflow helpers        |  ~100 tokens/skill
|   - test: Testing best practices     |
+--------------------------------------+

When model calls load_skill("git"):
+--------------------------------------+
| tool_result (Layer 2 -- on demand):  |
| <skill name="git">                   |
|   Full git workflow instructions...  |  ~2000 tokens
|   Step 1: ...                        |
| </skill>                             |
+--------------------------------------+
```

Layer 1: skill *names* in system prompt (cheap). Layer 2: full *body* via tool_result (on demand).

## How It Works

1. Each skill is a directory containing a `SKILL.md` with YAML frontmatter.

```
skills/
  pdf/
    SKILL.md       # ---\n name: pdf\n description: Process PDF files\n ---\n ...
  code-review/
    SKILL.md       # ---\n name: code-review\n description: Review code\n ---\n ...
```

2. SkillLoader scans for `SKILL.md` files, uses the directory name as the skill identifier.

```typescript
class SkillLoader {
  skills: Record<string, { meta: Record<string, string>; body: string }> = {};

  constructor(skillsDir: string) {
    this.loadAll(skillsDir);
  }

  private loadAll(dir: string): void {
    if (!existsSync(dir)) return;
    const scanDir = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) scanDir(join(current, entry.name));
        else if (entry.name === "SKILL.md") {
          const text = readFileSync(join(current, entry.name), "utf-8");
          const { meta, body } = this.parseFrontmatter(text);
          const name = meta.name || basename(current);
          this.skills[name] = { meta, body };
        }
      }
    };
    scanDir(dir);
  }

  getDescriptions(): string {
    return Object.entries(this.skills)
      .map(([name, s]) => `  - ${name}: ${s.meta.description || ""}`)
      .join("\n");
  }

  getContent(name: string): string {
    const skill = this.skills[name];
    if (!skill) return `Error: Unknown skill '${name}'.`;
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}
```

3. Layer 1 goes into the system prompt. Layer 2 is just another tool handler.

```typescript
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Skills available:
${SKILL_LOADER.getDescriptions()}`;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ...base tools...
  load_skill: (input) => SKILL_LOADER.getContent(input.name as string),
};
```

The model learns what skills exist (cheap) and loads them when relevant (expensive).

## What Changed From s04

| Component      | Before (s04)     | After (s05)                |
|----------------|------------------|----------------------------|
| Tools          | 5 (base + task)  | 5 (base + load_skill)      |
| System prompt  | Static string    | + skill descriptions       |
| Knowledge      | None             | skills/\*/SKILL.md files   |
| Injection      | None             | Two-layer (system + result)|

## Try It

```sh
cd learn-claude-code-ts
bun run agents/s05_skill_loading.ts
```

1. `What skills are available?`
2. `Load the agent-builder skill and follow its instructions`
3. `I need to do a code review -- load the relevant skill first`
4. `Build an MCP server using the mcp-builder skill`
