export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function publicError(error) {
  return error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'The request could not be completed.');
}
