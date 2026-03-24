---
name: mcp-builder
description: Build MCP (Model Context Protocol) servers that give Claude new capabilities. Use when user wants to create an MCP server, add tools to Claude, or integrate external services.
---

# MCP Server Building Skill

You now have expertise in building MCP (Model Context Protocol) servers. MCP enables Claude to interact with external services through a standardized protocol.

## What is MCP?

MCP servers expose:
- **Tools**: Functions Claude can call (like API endpoints)
- **Resources**: Data Claude can read (like files or database records)
- **Prompts**: Pre-built prompt templates

## Quick Start: TypeScript MCP Server

### 1. Project Setup

```bash
# Create project
mkdir my-mcp-server && cd my-mcp-server
npm init -y

# Install MCP SDK
npm install @modelcontextprotocol/sdk
```

### 2. Basic Server Template

```typescript
// src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
  name: "my-server",
  version: "1.0.0",
});

// Define tools
server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "hello",
      description: "Say hello to someone",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name to greet" },
        },
        required: ["name"],
      },
    },
    {
      name: "add_numbers",
      description: "Add two numbers together",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number", description: "First number" },
          b: { type: "number", description: "Second number" },
        },
        required: ["a", "b"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "hello") {
    return { content: [{ type: "text", text: `Hello, ${args.name}!` }] };
  }
  if (name === "add_numbers") {
    return { content: [{ type: "text", text: String(args.a + args.b) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport);
```

### 3. Register with Claude

Add to `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["tsx", "/path/to/src/index.ts"]
    }
  }
}
```

## Advanced Patterns

### External API Integration

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({ name: "weather-server", version: "1.0.0" });

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "get_weather") {
    const city = request.params.arguments.city;
    const resp = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=YOUR_API_KEY&q=${encodeURIComponent(city)}`
    );
    const data = await resp.json();
    return {
      content: [{
        type: "text",
        text: `${city}: ${data.current.temp_c}C, ${data.current.condition.text}`,
      }],
    };
  }
  throw new Error("Unknown tool");
});

const transport = new StdioServerTransport();
server.connect(transport);
```

### Database Access

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";

const server = new Server({ name: "db-server", version: "1.0.0" });
const db = new Database("data.db");

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "query_db",
      description: "Execute a read-only SQL query",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string", description: "SQL SELECT query" } },
        required: ["sql"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "query_db") {
    const sql = request.params.arguments.sql as string;
    if (!sql.trim().toUpperCase().startsWith("SELECT")) {
      return { content: [{ type: "text", text: "Error: Only SELECT queries allowed" }] };
    }
    const rows = db.prepare(sql).all();
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
  throw new Error("Unknown tool");
});

const transport = new StdioServerTransport();
server.connect(transport);
```

### Resources (Read-only Data)

```typescript
import { readFileSync } from "node:fs";

server.setRequestHandler("resources/list", async () => ({
  resources: [
    {
      uri: "config://settings",
      name: "Application Settings",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler("resources/read", async (request) => {
  const { uri } = request.params;

  if (uri === "config://settings") {
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: readFileSync("settings.json", "utf-8"),
      }],
    };
  }

  // Dynamic file resources
  if (uri.startsWith("file://")) {
    const path = uri.replace("file://", "");
    return {
      contents: [{
        uri,
        mimeType: "text/plain",
        text: readFileSync(path, "utf-8"),
      }],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});
```

## Testing

```bash
# Test with MCP Inspector
npx @anthropics/mcp-inspector npx tsx src/index.ts

# Or send test messages directly
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx tsx src/index.ts
```

## Best Practices

1. **Clear tool descriptions**: Claude uses these to decide when to call tools
2. **Input validation**: Always validate and sanitize inputs
3. **Error handling**: Return meaningful error messages
4. **Async by default**: Use async/await for I/O operations
5. **Security**: Never expose sensitive operations without auth
6. **Idempotency**: Tools should be safe to retry
