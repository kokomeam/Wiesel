/** Typed failures the /api/learn routes map to HTTP statuses. */

export type LearnErrorCode =
  | "not_found" // publication/lesson/block missing (or not visible)
  | "not_enrolled" // caller has no active/completed enrollment
  | "invalid_request" // payload failed a server-side invariant beyond Zod
  | "conflict" // e.g. attempt-number race lost twice
  | "server_error";

export class LearnError extends Error {
  readonly code: LearnErrorCode;
  constructor(code: LearnErrorCode, message: string) {
    super(message);
    this.name = "LearnError";
    this.code = code;
  }
}

export function learnErrorStatus(code: LearnErrorCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "not_enrolled":
      return 403;
    case "invalid_request":
      return 400;
    case "conflict":
      return 409;
    case "server_error":
      return 500;
  }
}
