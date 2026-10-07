import type { GateIssue } from '../validate';

/** A refusal with the problems found (the console shows them next to what they are about). */
export class GateError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID' | 'CONFLICT' | 'APPLY' | 'NOT_FOUND',
    readonly issues: GateIssue[] = [],
  ) {
    super(message);
  }
}
