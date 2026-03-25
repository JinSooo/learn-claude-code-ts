[English](./README.md) | [中文](./README-zh.md) | [日本語](./README-ja.md)

# learn-claude-code-ts

> **モデルこそがAgent、コードはHarness。**

本プロジェクトは [shareAI-lab](https://github.com/shareAI-lab) の **[learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)** の TypeScript 移植版です。

オリジナルは Python で実装されています。本プロジェクトはそれを TypeScript に移植し、フロントエンド開発者や Node.js ユーザーが学びやすくしています。

## クイックスタート

```sh
git clone https://github.com/JinSooo/learn-claude-code-ts
cd learn-claude-code-ts
bun install               # または: npm install
cp .env.example .env      # .env を編集し、ANTHROPIC_API_KEY を入力

bun run s01               # ここから始める
bun run s12               # 学習パスの終点
bun run full              # 全メカニズム統合版
```

Node.js 互換：
```sh
npm run s01:node
```

### Web 学習プラットフォーム

```sh
cd web && npm install && npm run dev   # http://localhost:3000
```

## 学習パス

| フェーズ | Session | トピック | モットー |
|----------|---------|----------|----------|
| **ループ** | s01 | Agent ループ | *ループ1つ + Bash だけで十分* |
| | s02 | ツール使用 | *ツール追加はハンドラー1つ追加するだけ* |
| **計画** | s03 | TodoWrite | *計画のない Agent は迷走する* |
| | s04 | サブAgent | *大きなタスクを分割、各サブタスクにクリーンなコンテキスト* |
| | s05 | スキル読み込み | *知識は必要な時にロード、事前に全部入れない* |
| | s06 | コンテキスト圧縮 | *コンテキストは溢れる、圧縮戦略が必要* |
| **永続化** | s07 | タスクシステム | *大目標を小タスクに分割、順序付け、ディスクに永続化* |
| | s08 | バックグラウンドタスク | *遅い操作はバックグラウンドで、Agent は考え続ける* |
| **チーム** | s09 | Agent チーム | *タスクが大きすぎたらチームメイトに委任* |
| | s10 | チームプロトコル | *チームメイト間には共通の通信ルールが必要* |
| | s11 | 自律 Agent | *チームメイトが自らタスクボードをスキャンし、自ら担当* |
| | s12 | Worktree 分離 | *各自が独立したディレクトリで作業、干渉なし* |
| **集大成** | full | 全統合 | 全メカニズムを1ファイルに |

## プロジェクト構成

```
learn-claude-code-ts/
├── agents/          # TypeScript リファレンス実装（s01-s12 + s_full）
├── docs/{en,zh,ja}/ # ドキュメント（3言語）
├── web/             # インタラクティブ学習プラットフォーム（Next.js 16）
└── skills/          # s05 用のスキルファイル
```

## ドキュメント

[English](./docs/en/) | [中文](./docs/zh/) | [日本語](./docs/ja/)

## Python → TypeScript 対照表

| | Python（オリジナル） | TypeScript（本プロジェクト） |
|---|---|---|
| ランタイム | `python3` | `bun` / `npx tsx` |
| コマンド実行 | `subprocess.run()` | `execSync()` / `exec()` |
| ファイル操作 | `pathlib.Path` | `node:fs` + `node:path` |
| 並行処理 | `threading.Thread` | 非同期関数（イベントループ） |
| パッケージ管理 | `pip` | `bun` / `npm` |

## クレジット

本プロジェクトは [shareAI-lab](https://github.com/shareAI-lab) の **[learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)** から移植されました。全てのアーキテクチャ設計、教育手法、ドキュメント構成はオリジナルプロジェクトに由来します。役に立ったと感じたら、ぜひオリジナルプロジェクトに Star をお願いします。

## License

MIT

---

**モデルこそがAgent、コードはHarness。優れたHarnessを構築せよ。**
