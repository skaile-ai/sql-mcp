// src/tools/introspection.ts
import type { Dialect, ColumnInfo, TableInfo } from "../dialect/types.js";
import { ok, err, type Envelope } from "../envelope.js";

export async function handleListSchemas(dialect: Dialect): Promise<Envelope<{ schemas: string[] }>> {
  try {
    return ok("sql.list_schemas", { schemas: await dialect.listSchemas() });
  } catch (e) {
    return err("sql.list_schemas", "TOOL_EXECUTION_ERROR", (e as Error).message);
  }
}

export async function handleListTables(
  dialect: Dialect,
  input: { schema?: string },
): Promise<Envelope<{ tables: TableInfo[] }>> {
  try {
    return ok("sql.list_tables", { tables: await dialect.listTables(input.schema) });
  } catch (e) {
    return err("sql.list_tables", "TOOL_EXECUTION_ERROR", (e as Error).message);
  }
}

export async function handleDescribeTable(
  dialect: Dialect,
  input: { table: string; schema?: string },
): Promise<Envelope<{ columns: ColumnInfo[] }>> {
  try {
    return ok("sql.describe_table", { columns: await dialect.describeTable(input.table, input.schema) });
  } catch (e) {
    const msg = (e as Error).message;
    // Identifier allowlist failures are caller errors, not server faults.
    if (/identifier/i.test(msg)) return err("sql.describe_table", "VALIDATION_ERROR", msg);
    return err("sql.describe_table", "TOOL_EXECUTION_ERROR", msg);
  }
}
