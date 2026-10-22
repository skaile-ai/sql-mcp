---
"@skaile/sql-mcp": minor
---

Send `instructions` in the MCP `initialize` result naming the server version, so an agent can say which sql-mcp version it is connected to. `SERVER_VERSION` now comes from package.json (it had stayed at 0.1.0 after the 0.1.1 release).
