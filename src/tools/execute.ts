// src/tools/execute.ts
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { classify } from "../classifier.js";
import { ok, err, type Envelope } from "../envelope.js";
import { safeErrorMessage } from "../scrub.js";

const TOOL = "sql.execute";

export interface ExecuteInput {
  sql: string;
  params?: unknown[];
}

export async function handleExecute(
  dialect: Dialect,
  _config: Config,
  input: ExecuteInput,
): Promise<Envelope<{ rowCount: number }>> {
  const cls = classify(input.sql, dialect.classifyHooks);
  if (cls.class !== "dml") {
    return err(TOOL, "ACCESS_DENIED", `sql.execute accepts a single DML statement only (got ${cls.class})`);
  }
  try {
    const native = dialect.rewriteParams(input.sql);
    return ok(TOOL, await dialect.execute(native, input.params ?? []));
  } catch (e) {
    return err(TOOL, "TOOL_EXECUTION_ERROR", safeErrorMessage(e));
  }
}
