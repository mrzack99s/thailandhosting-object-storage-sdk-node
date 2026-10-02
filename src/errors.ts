/** An error answer from the service, read from its Problem Details (RFC 9457).
 *  `code` is the machine-readable reason, for example `object_not_found`,
 *  `bucket_already_exists` or `busy`; the message is the problem's title. */
export class ObjectStorageError extends Error {
  readonly status: number;
  readonly code: string;
  /** The problem's `type` URI and `instance` (the request path), when the answer had a body. */
  readonly type?: string;
  readonly instance?: string;

  constructor(status: number, code: string, message: string, problem: { type?: string; instance?: string } = {}) {
    super(`${code} (HTTP ${status}): ${message}`);
    this.name = 'ObjectStorageError';
    this.status = status;
    this.code = code;
    this.type = problem.type;
    this.instance = problem.instance;
  }
}

/** The bucket, object or upload does not exist. */
export class NotFoundError extends ObjectStorageError {
  constructor(code: string, message: string, problem?: { type?: string; instance?: string }) {
    super(404, code, message, problem);
    this.name = 'NotFoundError';
  }
}

/** An `ifMatch` / `ifNoneMatch` / `ifUnmodifiedSince` condition was false (HTTP 412,
 *  code `precondition_failed`): nothing was written or deleted. Not retried. */
export class PreconditionFailedError extends ObjectStorageError {
  constructor(code: string, message: string, problem?: { type?: string; instance?: string }) {
    super(412, code, message, problem);
    this.name = 'PreconditionFailedError';
  }
}

/** `get` / `head` with `ifNoneMatch` or `ifModifiedSince` matched (HTTP 304): a cached copy is still current. */
export class NotModifiedError extends Error {
  constructor(key: string) {
    super(`not modified: ${key}`);
    this.name = 'NotModifiedError';
  }
}

/** What the service stored, or sent back, is not what it should be. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}
