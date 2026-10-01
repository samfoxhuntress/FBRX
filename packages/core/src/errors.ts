export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'POLICY_DENIED'
  | 'LOCKED'
  | 'MANAGED'
  | 'UNAVAILABLE'
  | 'FEATURE_UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'INTERNAL';

/** Errors that are safe to show to the user and cross process boundaries intact. */
export class CoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CoreError';
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function toCoreError(err: unknown): CoreError {
  if (err instanceof CoreError) return err;
  if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown[] }).issues)) {
    const issues = (err as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    const msg = issues.map((i) => `${i.path.map(String).join('.') || 'value'}: ${i.message}`).join('; ');
    return new CoreError('INVALID_ARGUMENT', msg, issues);
  }
  if (err instanceof Error && err.name === 'AbortError') return new CoreError('CANCELLED', 'Operation canceled');
  return new CoreError('INTERNAL', errorMessage(err));
}
