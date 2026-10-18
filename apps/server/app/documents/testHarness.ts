import { randomUUID } from "node:crypto";
import type { Authenticator, Identity } from "@docmind/auth";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { type NewDocument, filenameBind, titleBind } from "./repo";

export const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const U1B = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2"; // a second user of tenant 1
export const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

export const ALICE: Identity = { tenantId: T1, userId: U1 };
export const ALICE2: Identity = { tenantId: T1, userId: U1B };
export const BOB: Identity = { tenantId: T2, userId: U2 };

/** Two tenants; tenant 1 has two users. Run as the owner role. */
export async function seedUsers(owner: Pool): Promise<void> {
  await owner.query(`
    INSERT INTO tenants (id, name) VALUES ('${T1}', 'one'), ('${T2}', 'two');
    INSERT INTO users (id, tenant_id, email, password_hash) VALUES
      ('${U1}', '${T1}', 'alice@example.com', 'x'),
      ('${U1B}', '${T1}', 'alice2@example.com', 'x'),
      ('${U2}', '${T2}', 'bob@example.com', 'x')`);
}

export const BY_HEADER: Record<string, Identity> = { alice: ALICE, alice2: ALICE2, bob: BOB };

/** Test-only: who the caller is comes from the `x-test-user` header. */
export const testAuthenticator: Authenticator = {
  async authenticate(req) {
    return BY_HEADER[String(req.headers["x-test-user"])] ?? null;
  },
};

// Smallest inputs the sniffer accepts, plus padding so each is distinct bytes.
export const PNG = (tag = "") =>
  Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from(tag)]);
export const PDF = (tag = "") => Buffer.from(`%PDF-1.7\n${tag}\n%%EOF`);
export const TEXT = (tag = "") => Buffer.from(`some plain text ${tag}\n`);

/** A NewDocument with sealed title and filename; `over` replaces any plain field. */
export async function newDocument(
  fields: FieldCrypto,
  tenantId: string,
  ownerId: string,
  fingerprint: string,
  over: Partial<Omit<NewDocument, "titleEnc" | "filenameEnc">> = {},
): Promise<NewDocument> {
  const id = over.id ?? randomUUID();
  const cipher = fields.forUser(ownerId);
  return {
    id,
    tenantId,
    ownerId,
    titleEnc: await cipher.seal(titleBind(id), "Quarterly report"),
    filenameEnc: await cipher.seal(filenameBind(id), "Quarterly report.pdf"),
    mime: "application/pdf",
    sizeBytes: 10,
    contentAddress: `hmac-sha256:${fingerprint}`,
    fingerprint,
    ...over,
  };
}
