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

  it("scrubs token / api_key / secret / ssl_key style secrets", () => {
    expect(scrubCredentials("token=abc123 failed")).toBe("token=*** failed");
    expect(scrubCredentials("api_key=zzz; host=x")).toBe("api_key=***; host=x");
    expect(scrubCredentials("apikey=zzz")).toBe("apikey=***");
    expect(scrubCredentials("secret=hunter2")).toBe("secret=***");
    expect(scrubCredentials("ssl_key=/etc/k.pem")).toBe("ssl_key=***");
    expect(scrubCredentials("sslpassword=zzz")).toBe("sslpassword=***");
  });

  it("scrubs MSSQL connection-string style 'Password=...;'", () => {
    expect(scrubCredentials("Server=h;Database=d;User Id=sa;Password=P@ss1;")).toContain("Password=***;");
  });

  it("leaves clean text untouched", () => {
    expect(scrubCredentials("table users not found")).toBe("table users not found");
  });
});
