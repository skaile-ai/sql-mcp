// src/tools/query.ts
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { classify } from "../classifier.js";
import { encodeCursor, decodeCursor } from "../cursor.js";
import { capRows } from "../limits.js";
import { ok, err, type Envelope } from "../envelope.js";

const TOOL = "sql.query";

export interface QueryInput {
  sql: string;
  params?: unknown[];
  cursor?: string;
  limit?: number;
}

export interface QueryData {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  next_cursor?: string;
}

/** Wrap arbitrary user SELECT SQL as a sub-select so we can apply LIMIT/OFFSET uniformly. */
function paginate(sql: string, limit: number, offset: number): string {
  const trimmed = sql.replace(/;\s*$/, "");
  return `SELECT * FROM (${trimmed}) AS _page LIMIT ${limit} OFFSET ${offset}`;
}

export async function handleQuery(
  dialect: Dialect,
  config: Config,
  input: QueryInput,
): Promise<Envelope<QueryData>> {
  const cls = classify(input.sql);
  if (cls.class !== "select") {
    return err(TOOL, "ACCESS_DENIED", `sql.query accepts read-only SELECT only (got ${cls.class})`);
  }

  // Page size: bounded by maxRows. If the caller asked for more than the cap, we clip + warn.
  const requested = input.limit ?? config.maxRows;
  const overCap = requested > config.maxRows;
  const pageSize = Math.min(requested, config.maxRows);

  let offset = 0;
  if (input.cursor) {
    try {
      const c = decodeCursor(input.cursor, config.cursorSecret);
      offset = c.offset ?? 0;
    } catch (e) {
      return err(TOOL, "VALIDATION_ERROR", (e as Error).message);
    }
  }

  // Fetch one extra row to detect whether a further page exists.
  const native = dialect.rewriteParams(paginate(input.sql, pageSize + 1, offset));
  let result;
  try {
    result = await dialect.query(native, input.params ?? []);
  } catch (e) {
    return err(TOOL, "TOOL_EXECUTION_ERROR", (e as Error).message);
  }

  const hasMore = result.rows.length > pageSize;
  const pageRows = hasMore ? result.rows.slice(0, pageSize) : result.rows;

  let capped;
  try {
    capped = capRows(pageRows, pageSize, config.maxResultBytes);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("RESULT_TOO_LARGE")) return err(TOOL, "RESULT_TOO_LARGE", msg);
    return err(TOOL, "TOOL_EXECUTION_ERROR", msg);
  }

  const data: QueryData = {
    columns: result.columns,
    rows: capped.rows,
    rowCount: capped.rows.length,
    truncated: overCap,
  };
  if (hasMore) {
    data.next_cursor = encodeCursor({ mode: "offset", offset: offset + pageSize }, config.cursorSecret);
  }
  return ok(TOOL, data, overCap ? "ROWS_TRUNCATED" : undefined);
}
