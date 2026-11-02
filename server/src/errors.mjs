/**
 * API errors. Every error response is JSON: {error: {code, message}}.
 * Messages are fixed strings written here: they never echo the request's
 * Markdown, option values or Chromium's own error text.
 */

export class ApiError extends Error {
    /**
     * @param {number} status   HTTP status
     * @param {string} code     stable machine-readable code
     * @param {string} message  human-readable, never derived from request content
     * @param {{headers?: Record<string, string>, details?: object}} [extra]
     *        headers to send (Retry-After) and extra fields for the error object
     */
    constructor(status, code, message, {headers = {}, details = {}} = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.headers = headers;
        this.details = details;
    }
}

/** The JSON body for an error; anything that is not an ApiError becomes a bare 500. */
export function errorBody(err) {
    if (err instanceof ApiError) return {error: {code: err.code, message: err.message, ...err.details}};
    return {error: {code: 'internal_error', message: 'Internal error'}};
}

export function errorStatus(err) {
    return err instanceof ApiError ? err.status : 500;
}
