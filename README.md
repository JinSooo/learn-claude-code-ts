[English](./README.md) | [中文](./README-zh.md) | [日本語](./README-ja.md)

# learn-claude-code-ts

> **The model IS the agent. The code is the harness.**

TypeScript edition of **[learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)** by [shareAI-lab](https://github.com/shareAI-lab).

Original project is in Python. This repo ports it to TypeScript for frontend developers and Node.js users.

## Quick Start

```sh
git clone https://github.com/JinSooo/learn-claude-code-ts
cd learn-claude-code-ts
bun install               # or: npm install
cp .env.example .env      # Edit .env with your ANTHROPIC_API_KEY

bun run s01               # Start here
bun run s12               # Full progression endpoint
bun run full              # Capstone: all mechanisms combined
```

Node.js compatible:
```sh
npm run s01:node
```

### Web Platform

```sh
cd web && npm install && npm run dev   # http://localhost:3000
```

## Learning Path

| Phase | Session | Topic | Motto |
|-------|---------|-------|-------|
| **Loop** | s01 | Agent Loop | *One loop & Bash is all you need* |
| | s02 | Tool Use | *Adding a tool means adding one handler* |
| **Planning** | s03 | TodoWrite | *An agent without a plan drifts* |
| | s04 | Subagents | *Break big tasks down; each subtask gets a clean context* |
| | s05 | Skills | *Load knowledge when you need it, not upfront* |
| | s06 | Context Compact | *Context will fill up; you need a way to make room* |
| **Persistence** | s07 | Tasks | *Break big goals into small tasks, order them, persist to disk* |
| | s08 | Background Tasks | *Run slow operations in the background; the agent keeps thinking* |
| **Teams** | s09 | Agent Teams | *When the task is too big for one, delegate to teammates* |
| | s10 | Team Protocols | *Teammates need shared communication rules* |
| | s11 | Autonomous Agents | *Teammates scan the board and claim tasks themselves* |
| | s12 | Worktree Isolation | *Each works in its own directory, no interference* |
| **Capstone** | full | All Combined | All mechanisms in one file |

## Architecture

```
learn-claude-code-ts/
├── agents/          # TypeScript implementations (s01-s12 + s_full)
├── docs/{en,zh,ja}/    # Documentation (3 languages)
├── web/             # Interactive learning platform (Next.js 16)
└── skills/          # Skill files for s05
```

## Documentation

Available in [English](./docs/en/) | [中文](./docs/zh/) | [日本語](./docs/ja/).

## Python → TypeScript

| | Python (original) | TypeScript (this repo) |
|---|---|---|
| Runtime | `python3` | `bun` / `npx tsx` |
| Shell | `subprocess.run()` | `execSync()` / `exec()` |
| File I/O | `pathlib.Path` | `node:fs` + `node:path` |
| Threading | `threading.Thread` | Async functions (event loop) |
| Package | `pip` | `bun` / `npm` |

## Credits

This project is a TypeScript port of **[learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)** by [shareAI-lab](https://github.com/shareAI-lab). All architectural design, teaching methodology, and documentation structure originate from the original project. Please star the original repo if you find this useful.

## License

MIT

---

**The model is the agent. The code is the harness. Build great harnesses.**
