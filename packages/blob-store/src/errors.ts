/** The bytes on disk are not a blob this user sealed, or were changed. */
export class BlobCorruptError extends Error {
  constructor(message = "blob failed authentication") {
    super(message);
    this.name = "BlobCorruptError";
  }
}

/** A stream passed the size cap while it was being written. */
export class BlobTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`blob exceeds the ${maxBytes}-byte limit`);
    this.name = "BlobTooLargeError";
  }
}

/** The user's data key is gone (or was never created) so the blob cannot be opened. */
export class BlobKeyUnavailableError extends Error {
  constructor() {
    super("the data key for this blob's owner is unavailable");
    this.name = "BlobKeyUnavailableError";
  }
}
