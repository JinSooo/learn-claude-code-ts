# learn-claude-code-ts

> The model IS the agent. The code is the harness.

TypeScript 版的 [learn-claude-code](https://github.com/anthropics/learn-claude-code)，用 12 个渐进式课程教你从零构建 AI Agent。

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的 API Key

# 3. 运行任意课程
bun run s01   # Agent Loop
bun run s02   # Tool Use
bun run s03   # TodoWrite
```

## Node.js 兼容

```bash
npm install
npm run s01:node
```

## 学习路径

| Phase | Session | 主题 | 核心概念 |
|-------|---------|------|---------|
| **Loop** | s01 | Agent Loop | 一个循环 + Bash 就够了 |
| | s02 | Tool Use | 加工具只需加一个 handler |
| **Planning** | s03 | TodoWrite | Agent 自己跟踪进度 |
| | s04 | Subagents | 子任务用独立上下文 |
| | s05 | Skills | 按需加载知识，而非全部塞进 prompt |
| | s06 | Context Compact | 上下文会满，需要压缩 |
| **Persistence** | s07 | Tasks | 任务持久化到文件，不怕压缩 |
| | s08 | Background Tasks | 后台运行，不阻塞思考 |
| **Teams** | s09 | Agent Teams | 多个 Agent 通过信箱协作 |
| | s10 | Team Protocols | 关机和计划审批的握手协议 |
| | s11 | Autonomous Agents | Agent 自己找活干 |
| | s12 | Worktree Isolation | 每个任务一个工作目录 |
| **Capstone** | full | All Combined | 所有机制合一 |

## 致谢

本项目基于 [learn-claude-code](https://github.com/anthropics/learn-claude-code)（Python 版）移植而来。
