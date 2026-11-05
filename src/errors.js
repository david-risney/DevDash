export class DevDashError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'DevDashError';
    this.code = code;
  }
}

export function errorJson(error) {
  return {
    error: {
      code: error instanceof DevDashError ? error.code : 'IO_ERROR',
      message: error.message,
      ...(typeof error.diagnosticId === 'string' ? { diagnosticId: error.diagnosticId } : {}),
    },
  };
}
