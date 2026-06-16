import { describe, it, expect } from "vitest";
import { rewriteToNamed, inferTdsType } from "../../src/dialect/mssql-params.js";

describe("MSSQL param helpers", () => {
  it("rewrites $1,$2 to @p1,@p2", () => {
    expect(rewriteToNamed("SELECT * FROM t WHERE a=$1 AND b=$2")).toBe("SELECT * FROM t WHERE a=@p1 AND b=@p2");
  });

  it("repeated $1 maps to @p1 in every position", () => {
    expect(rewriteToNamed("SELECT $1, $1")).toBe("SELECT @p1, @p1");
  });

  it("infers TDS types by JS value", () => {
    expect(inferTdsType(42).name).toBe("Int");
    expect(inferTdsType(2 ** 40).name).toBe("BigInt");
    expect(inferTdsType(3.14).name).toBe("Float");
    expect(inferTdsType("hi").name).toBe("NVarChar");
    expect(inferTdsType(true).name).toBe("Bit");
    expect(inferTdsType(new Date()).name).toBe("DateTime2");
    expect(inferTdsType(Buffer.from("x")).name).toBe("VarBinary");
    expect(inferTdsType(null).name).toBe("NVarChar"); // null still needs a declared type
  });
});
