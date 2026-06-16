// src/dialect/index.ts
import type { Config } from "../config.js";
import type { Dialect } from "./types.js";
import { SqliteDialect } from "./sqlite.js";
import { PostgresDialect } from "./postgres.js";
import { MysqlDialect } from "./mysql.js";

/** Construct the configured dialect. */
export function createDialect(config: Config): Dialect {
  switch (config.dialect) {
    case "sqlite":
      return new SqliteDialect(config.access);
    case "postgres":
      return new PostgresDialect(config.access, undefined, config.statementTimeoutMs);
    case "mysql":
      return new MysqlDialect(config.access, undefined, config.statementTimeoutMs);
    default:
      throw new Error(`DIALECT_UNSUPPORTED: ${config.dialect} is not implemented yet`);
  }
}
