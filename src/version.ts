// package.json is the single source of truth: changesets bumps it on release.
import { version } from "../package.json";

export const SERVER_VERSION: string = version;

/**
 * Sent as `instructions` in the MCP `initialize` result. Clients show
 * `serverInfo.version` only to the human; instructions reach the model
 * (Claude Code, Agent SDK), so this is how an agent can tell which version
 * it is connected to.
 */
export const SERVER_INSTRUCTIONS =
  `sql-mcp ${SERVER_VERSION}: runs SQL against one configured PostgreSQL, MySQL, SQLite or ` +
  `Microsoft SQL Server database, read-only unless its access scope enables writes. ` +
  `When asked which version of this server is running, the answer is ${SERVER_VERSION}.`;
