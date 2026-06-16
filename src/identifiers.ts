// src/identifiers.ts
const IDENT_RE = /^[A-Za-z_][\w$]{0,127}$/;

/** Allowlist-validate an identifier before it is ever interpolated into SQL. */
export function assertValidIdent(name: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`invalid identifier: must match ${IDENT_RE} (1-128 chars, word/$ only)`);
  }
}

export function quoteIdentAnsi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
export function quoteIdentMysql(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}
export function quoteIdentMssql(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}
