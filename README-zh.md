[English](./README.md) | [中文](./README-zh.md)

# learn-claude-code-ts

> **模型即 Agent，代码即 Harness。**

本项目是 [shareAI-lab](https://github.com/shareAI-lab) 的 **[learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)** 的 TypeScript 移植版。

原项目用 Python 实现，本项目将其移植为 TypeScript，方便前端开发者和 Node.js 用户学习。

## 快速开始

```sh
git clone https://github.com/JinSooo/learn-claude-code-ts
cd learn-claude-code-ts
bun install               # 或: npm install
cp .env.example .env      # 编辑 .env，填入你的 ANTHROPIC_API_KEY

bun run s01               # 从这里开始
bun run s12               # 完整学习路径的终点
bun run full              # 终极整合：所有机制合一
```

Node.js 兼容：
```sh
npm run s01:node
```

### Web 学习平台

```sh
cd web && npm install && npm run dev   # http://localhost:3000
```

## 学习路径

| 阶段 | Session | 主题 | 格言 |
|------|---------|------|------|
| **循环** | s01 | Agent 循环 | *一个循环 + Bash 就够了* |
| | s02 | 工具使用 | *加工具只需加一个 handler* |
| **规划** | s03 | TodoWrite | *没有计划的 Agent 会迷失方向* |
| | s04 | 子 Agent | *大任务拆小，每个子任务一个干净上下文* |
| | s05 | 技能加载 | *按需加载知识，而非全部塞进 prompt* |
| | s06 | 上下文压缩 | *上下文会满，你需要压缩策略* |
| **持久化** | s07 | 任务系统 | *大目标拆小任务，排好序，持久化到磁盘* |
| | s08 | 后台任务 | *慢操作放后台跑，Agent 继续思考* |
| **团队** | s09 | Agent 团队 | *任务太大就委派给队友* |
| | s10 | 团队协议 | *队友之间需要共同的通信规则* |
| | s11 | 自主 Agent | *队友自己扫描任务板，自己认领* |
| | s12 | Worktree 隔离 | *各自在独立目录工作，互不干扰* |
| **终极** | full | 全部整合 | 所有机制合一 |

## 项目结构

```
learn-claude-code-ts/
├── agents/          # TypeScript 参考实现（s01-s12 + s_full）
├── docs/{en,zh}/    # 文档（2 种语言）
├── web/             # 交互式学习平台（Next.js 16）
└── skills/          # s05 使用的技能文件
```

## 文档

[English](./docs/en/) | [中文](./docs/zh/)

## Python → TypeScript 对照

| | Python（原版） | TypeScript（本项目） |
|---|---|---|
| 运行时 | `python3` | `bun` / `npx tsx` |
| 命令执行 | `subprocess.run()` | `execSync()` / `exec()` |
| 文件操作 | `pathlib.Path` | `node:fs` + `node:path` |
| 并发 | `threading.Thread` | 异步函数（事件循环） |
| 包管理 | `pip` | `bun` / `npm` |

## 致谢

本项目源自 [shareAI-lab](https://github.com/shareAI-lab) 的 **[learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)**。所有架构设计、教学方法和文档结构均来自原项目。如果觉得有用，请给原项目一个 Star。

## License

MIT

---

**模型即 Agent，代码即 Harness。构建伟大的 Harness。**
