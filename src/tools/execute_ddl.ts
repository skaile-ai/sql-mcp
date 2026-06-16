// src/tools/execute_ddl.ts
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { classify } from "../classifier.js";
import { ok, err, type Envelope } from "../envelope.js";
import { safeErrorMessage } from "../scrub.js";

const TOOL = "sql.execute_ddl";

export interface ExecuteDdlInput {
  sql: string;
}

export async function handleExecuteDdl(
  dialect: Dialect,
  _config: Config,
  input: ExecuteDdlInput,
): Promise<Envelope<{ rowCount: number }>> {
  const cls = classify(input.sql, dialect.classifyHooks);
  if (cls.class !== "ddl") {
    return err(TOOL, "ACCESS_DENIED", `sql.execute_ddl accepts a single DDL statement only (got ${cls.class})`);
  }
  try {
    const native = dialect.rewriteParams(input.sql);
    return ok(TOOL, await dialect.execute(native, []));
  } catch (e) {
    return err(TOOL, "TOOL_EXECUTION_ERROR", safeErrorMessage(e));
  }
}
