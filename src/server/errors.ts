/**
 * HTTP error responses for the Diakosys API.
 */

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export function createApiError(
  statusCode: number,
  error: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return { statusCode, error, message, ...(details !== undefined ? { details } : {}) };
}

// HTTP Status codes used by the API
export const ERROR_CODES = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type HttpStatusCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
