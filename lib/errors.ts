/**
 * lib/errors.ts
 * Typed error hierarchy for TrialMatch India.
 *
 * Every API error thrown in a route handler is one of these.
 * api-handler.ts catches them and maps to HTTP responses.
 * Unknown errors become 500s (details hidden from client, logged server-side).
 */

export class AppError extends Error {
  /** Machine-readable error code for client handling */
  readonly code:    string
  /** HTTP status code */
  readonly status:  number
  /** Extra context for logging (NOT sent to client) */
  readonly context: Record<string, any>

  constructor(message: string, code: string, status: number, context: Record<string, any> = {}) {
    super(message)
    this.name    = this.constructor.name
    this.code    = code
    this.status  = status
    this.context = context
  }
}

// ── Auth errors ───────────────────────────────────────────────────────────

export class UnauthorisedError extends AppError {
  constructor(message = 'You must be signed in to access this resource.') {
    super(message, 'UNAUTHORISED', 401)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', context: Record<string, any> = {}) {
    super(message, 'FORBIDDEN', 403, context)
  }
}

export class WrongOrgTypeError extends AppError {
  constructor(required: string, actual: string) {
    super(
      `This feature is only available to ${required} organisations.`,
      'WRONG_ORG_TYPE',
      403,
      { required, actual }
    )
  }
}

// ── Validation errors ─────────────────────────────────────────────────────

export class ValidationError extends AppError {
  readonly fieldErrors: Record<string, string>

  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message, 'VALIDATION_ERROR', 400, { fieldErrors })
    this.fieldErrors = fieldErrors
  }
}

export class MissingFieldError extends ValidationError {
  constructor(field: string) {
    super(`${field} is required.`, { [field]: `${field} is required` })
  }
}

// ── Not found errors ──────────────────────────────────────────────────────

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} not found (id: ${id}).` : `${resource} not found.`,
      'NOT_FOUND',
      404,
      { resource, id }
    )
  }
}

// ── Rate limit errors ─────────────────────────────────────────────────────

export class RateLimitError extends AppError {
  readonly resetInMs: number

  constructor(message: string, resetInMs: number) {
    super(message, 'RATE_LIMITED', 429, { resetInMs })
    this.resetInMs = resetInMs
  }
}

// ── Plan / billing errors ─────────────────────────────────────────────────

export class PlanLimitError extends AppError {
  readonly upgrade: string

  constructor(message: string, upgrade: string) {
    super(message, 'PLAN_LIMIT', 402, { upgrade })
    this.upgrade = upgrade
  }
}

// ── Conflict errors ───────────────────────────────────────────────────────

export class ConflictError extends AppError {
  constructor(message: string, context: Record<string, any> = {}) {
    super(message, 'CONFLICT', 409, context)
  }
}

// ── External service errors ───────────────────────────────────────────────

export class ExternalServiceError extends AppError {
  constructor(service: string, message: string) {
    super(
      `An error occurred communicating with ${service}. Please try again.`,
      'EXTERNAL_SERVICE_ERROR',
      502,
      { service, originalMessage: message }
    )
  }
}

export class AIServiceError extends AppError {
  constructor(message: string) {
    super(
      'The AI service encountered an error. Your request has been logged and you can try again.',
      'AI_SERVICE_ERROR',
      502,
      { originalMessage: message }
    )
  }
}

// ── Internal errors ───────────────────────────────────────────────────────

export class DatabaseError extends AppError {
  constructor(operation: string, message: string) {
    super(
      'A database error occurred. Please try again or contact support.',
      'DATABASE_ERROR',
      500,
      { operation, originalMessage: message }
    )
  }
}

// ── Helper ────────────────────────────────────────────────────────────────

/** Convert an unknown throw into an AppError for safe handling */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  if (err instanceof Error)    return new AppError(err.message, 'INTERNAL', 500)
  return new AppError('An unexpected error occurred.', 'INTERNAL', 500)
}

/** Serialise an AppError for HTTP response (hides sensitive context) */
export function serialiseError(err: AppError): { code: string; message: string; fieldErrors?: Record<string, string> } {
  const base: any = { code: err.code, message: err.message }
  if (err instanceof ValidationError && Object.keys(err.fieldErrors).length > 0) {
    base.fieldErrors = err.fieldErrors
  }
  return base
}
