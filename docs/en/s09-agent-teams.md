# s09: Agent Teams

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > [ s09 ] s10 > s11 > s12`

> *"When the task is too big for one, delegate to teammates"* -- persistent teammates + async mailboxes.
>
> **Harness layer**: Team mailboxes -- multiple models, coordinated through files.

## Problem

Subagents (s04) are disposable: spawn, work, return summary, die. No identity, no memory between invocations. Background tasks (s08) run shell commands but can't make LLM-guided decisions.

Real teamwork needs: (1) persistent agents that outlive a single prompt, (2) identity and lifecycle management, (3) a communication channel between agents.

## Solution

```
Teammate lifecycle:
  spawn -> WORKING -> IDLE -> WORKING -> ... -> SHUTDOWN

Communication:
  .team/
    config.json           <- team roster + statuses
    inbox/
      alice.jsonl         <- append-only, drain-on-read
      bob.jsonl
      lead.jsonl

              +--------+    send("alice","bob","...")    +--------+
              | alice  | -----------------------------> |  bob   |
              | loop   |    bob.jsonl << {json_line}    |  loop  |
              +--------+                                +--------+
                   ^                                         |
                   |        BUS.readInbox("alice")           |
                   +---- alice.jsonl -> read + drain ---------+
```

## How It Works

1. TeammateManager maintains config.json with the team roster.

```typescript
interface MemberConfig { name: string; role: string; status: string }
interface TeamConfig { team_name: string; members: MemberConfig[] }

class TeammateManager {
  dir: string;
  configPath: string;
  config: TeamConfig;

  constructor(teamDir: string) {
    this.dir = teamDir;
    mkdirSync(this.dir, { recursive: true });
    this.configPath = join(this.dir, "config.json");
    this.config = this._loadConfig();
  }
}
```

2. `spawn()` creates a teammate and starts its agent loop as an async fire-and-forget call.

```typescript
spawn(name: string, role: string, prompt: string): string {
  let member = this._findMember(name);
  if (member) {
    if (member.status !== "idle" && member.status !== "shutdown") {
      return `Error: '${name}' is currently ${member.status}`;
    }
    member.status = "working";
    member.role = role;
  } else {
    member = { name, role, status: "working" };
    this.config.members.push(member);
  }
  this._saveConfig();
  // Fire-and-forget async teammate loop
  this._teammateLoop(name, role, prompt);
  return `Spawned '${name}' (role: ${role})`;
}
```

3. MessageBus: append-only JSONL inboxes. `send()` appends a JSON line; `readInbox()` reads all and drains.

```typescript
class MessageBus {
  send(sender: string, to: string, content: string,
       msgType: string = "message", extra?: Record<string, unknown>): string {
    const msg: Record<string, unknown> = {
      type: msgType, from: sender,
      content, timestamp: Date.now() / 1000,
    };
    if (extra) Object.assign(msg, extra);
    appendFileSync(join(this.dir, `${to}.jsonl`), JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Record<string, unknown>[] {
    const inboxPath = join(this.dir, `${name}.jsonl`);
    if (!existsSync(inboxPath)) return [];
    const text = readFileSync(inboxPath, "utf-8").trim();
    const messages = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    writeFileSync(inboxPath, "");  // drain
    return messages;
  }
}
```

4. Each teammate checks its inbox before every LLM call, injecting received messages into context.

```typescript
async _teammateLoop(name: string, role: string, prompt: string): Promise<void> {
  const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: prompt }];
  for (let i = 0; i < 50; i++) {
    const inbox = BUS.readInbox(name);
    for (const msg of inbox) {
      messages.push({ role: "user", content: JSON.stringify(msg) });
    }
    const response = await client.messages.create(/* ... */);
    if (response.stop_reason !== "tool_use") break;
    // execute tools, append results...
  }
  const member = this._findMember(name);
  if (member) { member.status = "idle"; this._saveConfig(); }
}
```

## What Changed From s08

| Component      | Before (s08)     | After (s09)                |
|----------------|------------------|----------------------------|
| Tools          | 6                | 9 (+spawn/send/read_inbox) |
| Agents         | Single           | Lead + N teammates         |
| Persistence    | None             | config.json + JSONL inboxes|
| Concurrency    | Background cmds  | Full agent loops per async call|
| Lifecycle      | Fire-and-forget  | idle -> working -> idle    |
| Communication  | None             | message + broadcast        |

## Try It

```sh
cd learn-claude-code-ts
bun run agents/s09_agent_teams.ts
```

1. `Spawn alice (coder) and bob (tester). Have alice send bob a message.`
2. `Broadcast "status update: phase 1 complete" to all teammates`
3. `Check the lead inbox for any messages`
4. Type `/team` to see the team roster with statuses
5. Type `/inbox` to manually check the lead's inbox
