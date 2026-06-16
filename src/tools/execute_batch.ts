// src/tools/execute_batch.ts
import type { Config } from "../config.js";
import type { Dialect, BatchStatement } from "../dialect/types.js";
import { classify } from "../classifier.js";
import { ok, err, type Envelope } from "../envelope.js";
import { safeErrorMessage } from "../scrub.js";

const TOOL = "sql.execute_batch";

// Bounds the work a single batch can pin to the connection. Could become configurable later.
const MAX_BATCH_STATEMENTS = 100;

export interface ExecuteBatchInput {
  statements: BatchStatement[];
}

export async function handleExecuteBatch(
  dialect: Dialect,
  _config: Config,
  input: ExecuteBatchInput,
): Promise<Envelope<{ results: Array<{ rowCount: number }> }>> {
  if (!input.statements || input.statements.length === 0) {
    return err(TOOL, "VALIDATION_ERROR", "execute_batch requires at least one statement");
  }

  if (input.statements.length > MAX_BATCH_STATEMENTS) {
    return err(TOOL, "VALIDATION_ERROR", `execute_batch accepts at most ${MAX_BATCH_STATEMENTS} statements per call`);
  }

  // Classify EVERY statement before anything executes; any non-DML rejects the whole batch.
  for (let i = 0; i < input.statements.length; i++) {
    const cls = classify(input.statements[i]!.sql, dialect.classifyHooks);
    if (cls.class !== "dml") {
      return err(TOOL, "ACCESS_DENIED", `statement ${i} is not DML (got ${cls.class}); batch rejected`);
    }
  }

  const native: BatchStatement[] = input.statements.map((s) => ({
    sql: dialect.rewriteParams(s.sql),
    params: s.params ?? [],
  }));

  try {
    return ok(TOOL, { results: await dialect.executeBatch(native) });
  } catch (e) {
    return err(TOOL, "TOOL_EXECUTION_ERROR", safeErrorMessage(e));
  }
}
