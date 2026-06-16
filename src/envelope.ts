// src/envelope.ts
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "ACCESS_DENIED"
  | "CONNECTION_FAILED"
  | "STATEMENT_TIMEOUT"
  | "RESULT_TOO_LARGE"
  | "DIALECT_UNSUPPORTED"
  | "TOOL_EXECUTION_ERROR";

export interface SuccessEnvelope<T> {
  status: "success";
  tool_name: string;
  retriable: false;
  data: T;
  warning?: string;
}

export interface ErrorEnvelope {
  status: "error";
  tool_name: string;
  code: ErrorCode;
  error: string;
  retriable: boolean;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function ok<T>(toolName: string, data: T, warning?: string): SuccessEnvelope<T> {
  const env: SuccessEnvelope<T> = { status: "success", tool_name: toolName, retriable: false, data };
  if (warning) env.warning = warning;
  return env;
}

export function err(
  toolName: string,
  code: ErrorCode,
  error: string,
  retriable = false,
): ErrorEnvelope {
  return { status: "error", tool_name: toolName, code, error, retriable };
}
