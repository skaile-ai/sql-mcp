# @skaile/sql-mcp

## 0.2.0

### Minor Changes

- [#13](https://github.com/skaile-ai/sql-mcp/pull/13) [`61e7dbd`](https://github.com/skaile-ai/sql-mcp/commit/61e7dbd882bdc16a1b436c0c3acbfac85375b4f5) Thanks [@peteralbert](https://github.com/peteralbert)! - Send `instructions` in the MCP `initialize` result naming the server version, so an agent can say which sql-mcp version it is connected to. `SERVER_VERSION` now comes from package.json (it had stayed at 0.1.0 after the 0.1.1 release).
