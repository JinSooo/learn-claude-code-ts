# s10: Team Protocols

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > [ s10 ] s11 > s12`

> *"チームメイト間には統一の通信ルールが必要"* -- 1つの request-response パターンが全交渉を駆動。
>
> **Harness 層**: プロトコル -- モデル間の構造化されたハンドシェイク。

## 問題

s09ではチームメイトが作業し通信するが、構造化された協調がない:

**シャットダウン**: 非同期ループを強制終了するとファイルが中途半端に書かれ、config.jsonが不正な状態になる。ハンドシェイクが必要 -- リーダーが要求し、チームメイトが承認(完了して退出)か拒否(作業継続)する。

**プラン承認**: リーダーが「認証モジュールをリファクタリングして」と言うと、チームメイトは即座に開始する。リスクの高い変更では、実行前にリーダーが計画をレビューすべきだ。

両方とも同じ構造: 一方がユニークIDを持つリクエストを送り、他方がそのIDで応答する。

## 解決策

```
Shutdown Protocol            Plan Approval Protocol
==================           ======================

Lead             Teammate    Teammate           Lead
  |                 |           |                 |
  |--shutdown_req-->|           |--plan_req------>|
  | {req_id:"abc"}  |           | {req_id:"xyz"}  |
  |                 |           |                 |
  |<--shutdown_resp-|           |<--plan_resp-----|
  | {req_id:"abc",  |           | {req_id:"xyz",  |
  |  approve:true}  |           |  approve:true}  |

Shared FSM:
  [pending] --approve--> [approved]
  [pending] --reject---> [rejected]

Trackers:
  shutdown_requests = {req_id: {target, status}}
  plan_requests     = {req_id: {from, plan, status}}
```

## 仕組み

1. リーダーがrequest_idを生成し、インボックス経由でシャットダウンを開始する。

```typescript
const shutdownRequests: Record<string, { target?: string; status: string }> = {};

function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down gracefully.",
           "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent (status: pending)`;
}
```

2. チームメイトがリクエストを受信し、承認または拒否で応答する。

```typescript
if (toolName === "shutdown_response") {
  const reqId = args.request_id as string;
  const approve = args.approve as boolean;
  if (reqId in shutdownRequests) {
    shutdownRequests[reqId].status = approve ? "approved" : "rejected";
  }
  BUS.send(sender, "lead", (args.reason as string) || "",
           "shutdown_response",
           { request_id: reqId, approve });
}
```

3. プラン承認も同一パターン。チームメイトがプランを提出(request_idを生成)、リーダーがレビュー(同じrequest_idを参照)。

```typescript
const planRequests: Record<string, { from: string; plan: string; status: string }> = {};

function handlePlanReview(requestId: string, approve: boolean, feedback = ""): string {
  const req = planRequests[requestId];
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback,
           "plan_approval_response",
           { request_id: requestId, approve });
  return `Plan ${req.status} for '${req.from}'`;
}
```

1つのFSM、2つの応用。同じ`pending -> approved | rejected`状態機械が、あらゆるリクエスト-レスポンスプロトコルに適用できる。

## s09からの変更点

| Component      | Before (s09)     | After (s10)                  |
|----------------|------------------|------------------------------|
| Tools          | 9                | 12 (+shutdown_req/resp +plan)|
| Shutdown       | Natural exit only| Request-response handshake   |
| Plan gating    | None             | Submit/review with approval  |
| Correlation    | None             | request_id per request       |
| FSM            | None             | pending -> approved/rejected |

## 試してみる

```sh
cd learn-claude-code-ts
bun run agents/s10_team_protocols.ts
```

1. `Spawn alice as a coder. Then request her shutdown.`
2. `List teammates to see alice's status after shutdown approval`
3. `Spawn bob with a risky refactoring task. Review and reject his plan.`
4. `Spawn charlie, have him submit a plan, then approve it.`
5. `/team`と入力してステータスを監視する
