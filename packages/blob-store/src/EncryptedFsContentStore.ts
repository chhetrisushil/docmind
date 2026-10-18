import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ContentRef, ContentStore } from "@loom/plugin-content";
import type { KeyStore } from "@loom/plugin-crypto";
import {
  addressOf,
  deriveFingerprintKey,
  fingerprintHasher,
  fingerprintOf,
  parseAddress,
  sameFingerprint,
} from "./address";
import { type BlobScope, openBytes, sealStream } from "./envelope";
import { BlobCorruptError, BlobKeyUnavailableError, BlobTooLargeError } from "./errors";
import { blobPath, userDirOf } from "./paths";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface EncryptedFsContentStoreOptions {
  /** Absolute directory that holds every tenant's blobs. */
  root: string;
  /** Canonical lowercase UUIDs: they become path segments, so nothing else is accepted. */
  tenantId: string;
  userId: string;
  /** Supplies the user's data key (subject = userId). */
  keys: KeyStore;
  /** Largest plaintext a stream may have. Default 50 MiB. */
  maxBytes?: number;
}

export interface StagedBlob {
  /** Keyed address (`hmac-sha256:<fingerprint>`) of the plaintext, and its size in bytes. */
  readonly ref: ContentRef;
  /** The bare 64-hex keyed hash: `documents.fingerprint` and the blob's file name. */
  readonly fingerprint: string;
  /**
   * Links the sealed file to its final path. `created` is false if this user already had it.
   * Callers must serialize commit and delete for the same user (the server holds a per-tenant lock).
   */
  commit(): Promise<{ created: boolean }>;
  /** Removes the staged file. A no-op once committed or discarded. */
  discard(): Promise<void>;
}

/**
 * Loom's ContentStore for one user, on the local filesystem. Bytes are addressed by an HMAC of the
 * plaintext keyed from the user's data key (see address.ts), sealed under that data key (see
 * envelope.ts) and written to `<root>/<tenantId>/<userId>/<fingerprint>`. The store computes the
 * address itself, so Loom's sha256 `contentAddress()` is never involved. No client string ever
 * reaches a path: the segments are validated UUIDs and a 64-digit hex fingerprint (see paths.ts).
 */
export class EncryptedFsContentStore implements ContentStore {
  readonly userDir: string;
  private readonly scope: BlobScope;
  private readonly keys: KeyStore;
  private readonly maxBytes: number;

  constructor(options: EncryptedFsContentStoreOptions) {
    this.userDir = userDirOf(options.root, options.tenantId, options.userId);
    this.scope = { tenantId: options.tenantId, userId: options.userId };
    this.keys = options.keys;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
  }

  /**
   * Streams `source` into a sealed temp file, fingerprinting and counting the plaintext on the way.
   * Throws `BlobTooLargeError` past `maxBytes`; any failure (source error, size cap, write error)
   * removes the temp file. Nothing is visible at the final path until `commit()`.
   */
  async stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob> {
    const dek = await this.keys.getOrCreate(this.scope.userId);
    const hash = fingerprintHasher(deriveFingerprintKey(dek));
    await mkdir(this.userDir, { recursive: true, mode: 0o700 });
    const tmp = join(this.userDir, `.tmp-${randomBytes(12).toString("hex")}`);
    const max = this.maxBytes;
    let size = 0;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        if (size + chunk.byteLength > max) throw new BlobTooLargeError(max);
        size += chunk.byteLength;
        hash.update(chunk);
        yield chunk;
      }
    }
    try {
      await pipeline(
        Readable.from(sealStream(dek, this.scope, counted()), { objectMode: false }),
        createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
      );
      const handle = await open(tmp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const fingerprint = hash.digest();
    const final = blobPath(this.userDir, fingerprint);
    let state: "staged" | "committed" | "discarded" = "staged";
    return {
      ref: { __loomContent: addressOf(fingerprint), size },
      fingerprint,
      commit: async () => {
        if (state !== "staged") throw new Error("blob is no longer staged");
        try {
          // link() fails with EEXIST instead of overwriting, so the no-overwrite check is atomic.
          let created = true;
          try {
            await link(tmp, final);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            created = false;
          }
          await rm(tmp, { force: true });
          state = "committed";
          return { created };
        } catch (err) {
          await rm(tmp, { force: true });
          state = "discarded";
          throw err;
        }
      },
      discard: async () => {
        if (state !== "staged") return;
        state = "discarded";
        await rm(tmp, { force: true });
      },
    };
  }

  async put(bytes: Uint8Array): Promise<ContentRef> {
    return this.putStream(
      (async function* () {
        yield bytes;
      })(),
    );
  }

  async putStream(stream: AsyncIterable<Uint8Array>): Promise<ContentRef> {
    const staged = await this.stage(stream);
    await staged.commit();
    return staged.ref;
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    const fingerprint = parseAddress(ref.__loomContent);
    if (!fingerprint) return null; // not an address this store could have issued
    let sealed: Buffer;
    try {
      sealed = await readFile(blobPath(this.userDir, fingerprint));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const dek = await this.keys.get(this.scope.userId);
    if (!dek) throw new BlobKeyUnavailableError();
    const plain = openBytes(dek, this.scope, sealed);
    if (!sameFingerprint(fingerprintOf(deriveFingerprintKey(dek), plain), fingerprint)) {
      throw new BlobCorruptError("blob content does not match its address");
    }
    return plain;
  }

  async delete(ref: ContentRef): Promise<void> {
    const fingerprint = parseAddress(ref.__loomContent);
    if (!fingerprint) return;
    await rm(blobPath(this.userDir, fingerprint), { force: true });
  }
}
