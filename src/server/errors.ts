export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function assert(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
