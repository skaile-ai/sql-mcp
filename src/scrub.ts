// src/scrub.ts
// Fail-safe: when in doubt, mask. Patterns run in order; each is conservative.
const PATTERNS: Array<[RegExp, string]> = [
  // URL-style DSN userinfo: scheme://user:PASSWORD@host  ->  scheme://user:***@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, "$1***$2"],
  // key=value secrets: password=..., pwd=..., Password=...;
  [/((?:password|pwd)\s*=\s*)[^;\s]+/gi, "$1***"],
  // Bearer tokens
  [/(\bBearer\s+)[A-Za-z0-9._\-]+/gi, "$1***"],
];

/** Strip credential material (DSN passwords, key=value secrets, bearer tokens) from any text
 *  before it reaches a tool envelope or a log line. */
export function scrubCredentials(text: string): string {
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Convenience: scrub an arbitrary thrown value down to a safe message string. */
export function safeErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return scrubCredentials(msg);
}
