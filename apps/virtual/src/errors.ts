/** An error with the HTTP status the API answers with and a message meant for people. */
export class VirtualError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new VirtualError(400, m);
export const unauthorized = (m = 'Sign in first') => new VirtualError(401, m);
export const forbidden = (m = 'Your role does not allow this') => new VirtualError(403, m);
export const notFound = (m: string) => new VirtualError(404, m);
export const conflict = (m: string) => new VirtualError(409, m);
export const unavailable = (m: string) => new VirtualError(503, m);

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
