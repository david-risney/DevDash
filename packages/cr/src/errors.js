export const ERROR_CODES = new Set([
  'INVALID_ARGUMENT', 'INVALID_PROFILE', 'BROWSER_FAILED', 'BROWSER_NOT_INSTALLED',
  'BROWSER_CLEANUP_FAILED', 'BUG_RESPONSE', 'BUG_EXTRACTION_FAILED', 'BUG_ACCESS_DENIED',
  'BUG_NOT_FOUND', 'BUG_TIMEOUT', 'BUG_UNAVAILABLE', 'BUG_HTTP', 'BUG_RENDER_FAILED',
  'PROVIDER_RESPONSE', 'PROVIDER_HTTP', 'PROVIDER_NETWORK',
  'LOG_WRITE_FAILED', 'LOG_READ_FAILED', 'UNEXPECTED_ERROR',
]);

export class CrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CrError';
    this.code = ERROR_CODES.has(code) ? code : 'UNEXPECTED_ERROR';
  }
}

export function safeError(error) {
  return error instanceof CrError ? error : new CrError('UNEXPECTED_ERROR', 'cr could not complete the command.');
}
