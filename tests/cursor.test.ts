// tests/cursor.test.ts
import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../src/cursor.js";

const SECRET = "test-secret";

describe("cursor", () => {
  it("round-trips an offset payload", () => {
    const token = encodeCursor({ mode: "offset", offset: 100 }, SECRET);
    expect(decodeCursor(token, SECRET)).toEqual({ mode: "offset", offset: 100 });
  });

  it("rejects a tampered payload", () => {
    const token = encodeCursor({ mode: "offset", offset: 100 }, SECRET);
    const [body] = token.split(".");
    const forged = `${body}xx.${token.split(".")[1]}`;
    expect(() => decodeCursor(forged, SECRET)).toThrow(/cursor/i);
  });

  it("rejects a token signed with a different secret", () => {
    const token = encodeCursor({ mode: "offset", offset: 1 }, SECRET);
    expect(() => decodeCursor(token, "other")).toThrow(/cursor/i);
  });

  it("rejects malformed tokens", () => {
    expect(() => decodeCursor("not-a-token", SECRET)).toThrow(/cursor/i);
  });
});
