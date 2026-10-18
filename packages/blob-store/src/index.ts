export {
  EncryptedFsContentStore,
  type EncryptedFsContentStoreOptions,
  type StagedBlob,
} from "./EncryptedFsContentStore";
export { BlobCorruptError, BlobKeyUnavailableError, BlobTooLargeError } from "./errors";
export { type BlobScope, OVERHEAD_BYTES, openBytes, sealStream } from "./envelope";
export {
  ADDRESS_PREFIX,
  FINGERPRINT_INFO,
  addressOf,
  deriveFingerprintKey,
  fingerprintHasher,
  fingerprintOf,
  parseAddress,
  sameFingerprint,
} from "./address";
export { eraseUserBlobs, removeStaleTemp } from "./maintenance";
