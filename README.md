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

| Session | 主题 | 核心概念 |
|---------|------|---------|
| s01 | Agent Loop | 一个循环 + Bash 就够了 |
| s02 | Tool Use | 加工具只需加一个 handler |
| s03 | TodoWrite | Agent 自己跟踪进度 |

## 致谢

本项目基于 [learn-claude-code](https://github.com/anthropics/learn-claude-code)（Python 版）移植而来。
