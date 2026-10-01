export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'ERROR',
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m, 'INVALID_ARGUMENT');
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m, 'UNAUTHENTICATED');
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m, 'FORBIDDEN');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'NOT_FOUND');
export const conflict = (m: string) => new HttpError(409, m, 'CONFLICT');
