// src/cursor.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface CursorPayload {
  mode: "offset" | "keyset";
  offset?: number; // offset mode
  orderKey?: string; // keyset mode (reserved for a later phase)
  lastValue?: string | number | null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** Encode a self-contained, integrity-protected cursor token: `<b64url(json)>.<b64url(hmac)>`. */
export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body, secret)}`;
}

/** Decode + verify a cursor token. Throws on any tampering, bad signature, or malformed input. */
export function decodeCursor(token: string, secret: string): CursorPayload {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("invalid cursor: malformed token");
  const [body, mac] = parts as [string, string];
  const expected = sign(body, secret);
  const a = fromB64url(mac);
  const b = fromB64url(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid cursor: signature mismatch");
  }
  try {
    return JSON.parse(fromB64url(body).toString("utf8")) as CursorPayload;
  } catch {
    throw new Error("invalid cursor: unparseable payload");
  }
}
