// tests/scrub.test.ts
import { describe, it, expect } from "vitest";
import { scrubCredentials } from "../src/scrub.js";

describe("scrubCredentials", () => {
  it("masks the password inside a DSN", () => {
    const out = scrubCredentials("connect ECONNREFUSED postgresql://admin:s3cret@host:5432/db");
    expect(out).not.toContain("s3cret");
    expect(out).toContain("postgresql://admin:***@host:5432/db");
  });

  it("masks mysql/mssql style DSNs too", () => {
    expect(scrubCredentials("mysql://u:p@h/d")).not.toContain(":p@");
    expect(scrubCredentials("Server=h;User Id=u;Password=p;")).not.toContain("Password=p");
  });

  it("masks bearer tokens", () => {
    expect(scrubCredentials("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
  });

  it("masks broadened credential key variants", () => {
    expect(scrubCredentials("passwd=hunter2")).not.toContain("hunter2");
    expect(scrubCredentials("pass=hunter2")).not.toContain("hunter2");
  });

  it("does not match credential keys inside a longer word", () => {
    expect(scrubCredentials("bypass=ok")).toBe("bypass=ok");
  });

  it("leaves clean text untouched", () => {
    expect(scrubCredentials("table users not found")).toBe("table users not found");
  });
});
