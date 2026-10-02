/** An error answer from the service. `code` is the machine-readable reason,
 *  for example `object_not_found`, `bucket_already_exists` or `busy`. */
export class ObjectStorageError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${code} (HTTP ${status}): ${message}`);
    this.name = 'ObjectStorageError';
    this.status = status;
    this.code = code;
  }
}

/** The bucket, object or upload does not exist. */
export class NotFoundError extends ObjectStorageError {
  constructor(code: string, message: string) {
    super(404, code, message);
    this.name = 'NotFoundError';
  }
}

/** `get(key, { ifNoneMatch })` matched: a cached copy is still current. */
export class NotModifiedError extends Error {
  constructor(key: string) {
    super(`not modified: ${key}`);
    this.name = 'NotModifiedError';
  }
}

/** What the service stored is not what was sent. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}
