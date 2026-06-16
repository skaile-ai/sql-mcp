// tests/classifier.test.ts
import { describe, it, expect } from "vitest";
import { classify } from "../src/classifier.js";

describe("classify", () => {
  it("classifies a plain SELECT", () => {
    expect(classify("SELECT * FROM users").class).toBe("select");
  });

  it("classifies DML", () => {
    expect(classify("UPDATE users SET active = true WHERE id = $1").class).toBe("dml");
    expect(classify("delete from users").class).toBe("dml");
  });

  it("classifies DDL", () => {
    expect(classify("DROP TABLE users").class).toBe("ddl");
    expect(classify("create table t (id int)").class).toBe("ddl");
    expect(classify("TRUNCATE users").class).toBe("ddl");
  });

  it("flags multiple statements", () => {
    expect(classify("SELECT 1; DROP TABLE users").class).toBe("multiple");
  });

  it("ignores a trailing semicolon", () => {
    expect(classify("SELECT 1;").class).toBe("select");
  });

  it("does not treat a ';' inside a string literal as a separator", () => {
    expect(classify("SELECT ';drop' AS x").class).toBe("select");
  });

  it("ignores keywords hidden in comments", () => {
    expect(classify("SELECT 1 -- DROP TABLE users").class).toBe("select");
    expect(classify("SELECT 1 /* delete from x */").class).toBe("select");
  });

  it("detects a data-modifying CTE as a write (not a read)", () => {
    const sql = "WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d";
    expect(classify(sql).class).toBe("dml");
  });

  it("does not misclassify a column literally named after a keyword", () => {
    // 'update' as a quoted identifier is masked, so it stays a select
    expect(classify('SELECT "update" FROM t').class).toBe("select");
  });

  it("handles a doubled-bracket escape inside an MSSQL bracket identifier", () => {
    // ']]' is an escaped ']'; the identifier is `x]delete`, so 'delete' must not leak.
    expect(classify("SELECT * FROM [x]]delete]").class).toBe("select");
  });
});
