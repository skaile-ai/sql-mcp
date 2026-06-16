// src/classifier.ts
export type StmtClass = "select" | "dml" | "ddl" | "other" | "multiple";

export interface ClassifyHooks {
  extraDml?: string[]; // e.g. ["merge"] for dialects that treat MERGE as DML
  extraDdl?: string[];
}

export interface ClassifyResult {
  class: StmtClass;
  reason?: string;
}

const DDL = ["create", "alter", "drop", "truncate", "rename"];
const DML = ["insert", "update", "delete", "replace", "upsert"];

/**
 * Mask string literals, quoted identifiers, and comments to a single space so that
 * keyword/`;` detection only sees real SQL syntax. Fail-closed by design.
 */
function mask(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue; } // doubled escape
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      out += " ";
    } else if (c === "[") {
      // MSSQL bracket identifier; ']]' is an escaped ']' (mirrors doubled-quote logic above).
      i++;
      while (i < n) {
        if (sql[i] === "]" && sql[i + 1] === "]") { i += 2; continue; } // doubled escape
        if (sql[i] === "]") { i++; break; }
        i++;
      }
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function hasWord(masked: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(masked);
}

export function classify(sql: string, hooks: ClassifyHooks = {}): ClassifyResult {
  const masked = mask(sql);

  // Statement stacking: any ';' with non-whitespace after it ⇒ multiple statements.
  const semiIdx = masked.indexOf(";");
  if (semiIdx !== -1 && masked.slice(semiIdx + 1).trim().length > 0) {
    return { class: "multiple", reason: "multiple statements are not allowed" };
  }

  const ddl = [...DDL, ...(hooks.extraDdl ?? [])];
  const dml = [...DML, ...(hooks.extraDml ?? [])];

  // Fail-closed precedence: DDL > DML > SELECT. A SELECT whose body contains a
  // data-modifying keyword (e.g. a data-modifying CTE) is treated as that class.
  if (ddl.some((k) => hasWord(masked, k))) return { class: "ddl" };
  if (dml.some((k) => hasWord(masked, k))) return { class: "dml" };
  if (hasWord(masked, "select") || hasWord(masked, "with")) return { class: "select" };
  return { class: "other", reason: "unrecognized statement" };
}
