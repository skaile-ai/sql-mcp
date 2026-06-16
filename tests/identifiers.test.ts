// tests/identifiers.test.ts
import { describe, it, expect } from "vitest";
import { assertValidIdent, quoteIdentAnsi, quoteIdentMysql, quoteIdentMssql } from "../src/identifiers.js";

describe("identifiers", () => {
  it("accepts normal names", () => {
    expect(() => assertValidIdent("users")).not.toThrow();
    expect(() => assertValidIdent("public_schema$1")).not.toThrow();
  });

  it("rejects injection attempts and oversized names", () => {
    expect(() => assertValidIdent('users"; DROP TABLE users; --')).toThrow(/identifier/i);
    expect(() => assertValidIdent("a".repeat(129))).toThrow(/identifier/i);
    expect(() => assertValidIdent("")).toThrow(/identifier/i);
  });

  it("quotes per dialect and escapes the close char", () => {
    expect(quoteIdentAnsi('a"b')).toBe('"a""b"');
    expect(quoteIdentMysql("a`b")).toBe("`a``b`");
    expect(quoteIdentMssql("a]b")).toBe("[a]]b]");
  });
});
