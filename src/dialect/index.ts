// src/dialect/index.ts
import type { Config } from "../config.js";
import type { Dialect } from "./types.js";
import { SqliteDialect } from "./sqlite.js";

/** Construct the configured dialect. Phase 1 supports sqlite only. */
export function createDialect(config: Config): Dialect {
  switch (config.dialect) {
    case "sqlite":
      return new SqliteDialect(config.access);
    default:
      throw new Error(`DIALECT_UNSUPPORTED: ${config.dialect} is not implemented yet`);
  }
}
