import type { Identity } from "@docmind/auth";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import type { Eraser } from "./eraser";
import type { ErasureState, ErasureStore } from "./types";

/** What `DELETE /api/me` needs from erasure: record it durably, then start it. */
export interface AccountErasure {
  /**
   * One transaction: the durable request (with `receiptHash`, the sha256 of the receipt token), every session of
   * the user gone, `erasing_at` set, and the email replaced by `erased:<user id>`. Resolves `true` when it
   * recorded the request. When a request already exists (two simultaneous valid requests) the receipt minted for
   * this call was not stored, so the whole transaction is rolled back and it resolves `false`: nothing changed.
   */
  request(identity: Identity, receiptHash: Buffer): Promise<boolean>;
  /** Closes the user's open streams, then runs the erasure in the background. Never throws and never waits. */
  start(userId: string): void;
  /**
   * The state of the erasure a receipt belongs to, by the sha256 of its token: `pending`, `done`, or `null` for
   * a hash that matches none. Needs no session and no tenant (`docmind_erasure_status`).
   */
  status(receiptHash: Buffer): Promise<ErasureState | null>;
}

/** Thrown inside the transaction to roll it back when the insert found an existing request. */
class AlreadyRequested extends Error {}

export function pgAccountErasure(o: {
  pool: Pool;
  store: Pick<ErasureStore, "insert" | "status">;
  eraser: Pick<Eraser, "run">;
  /** Ends the user's open event streams (documents and chats). Idempotent: the eraser's `stop` step calls it again. */
  closeStreams?: (userId: string) => void;
}): AccountErasure {
  return {
    async request(identity, receiptHash) {
      try {
        await withTenant(o.pool, identity.tenantId, async (tx) => {
          if (!(await o.store.insert(tx, identity.userId, identity.tenantId, receiptHash)))
            throw new AlreadyRequested();
          await tx.query("DELETE FROM auth_sessions WHERE user_id = $1", [identity.userId]);
          // The address is free from here: login can no longer match it (`erasing_at` refuses the row a second time),
          // sign-up with it makes a new account, and no table still holds it. The app role may update `users`
          // under its own tenant's policy (0002, pinned by erasureRequests.pg.test.ts). `'erased:' || id` is unique
          // and not a valid email, so nobody can sign up or log in as it; the `rows` step deletes the row.
          const scrub = await tx.query(
            "UPDATE users SET erasing_at = COALESCE(erasing_at, now()), email = 'erased:' || id::text WHERE id = $1",
            [identity.userId],
          );
          // Exactly the one row, or the whole transaction rolls back: a silent 0 (a narrowed policy) would leave a
          // live account with its sessions gone and a receipt in the caller's hand.
          if (scrub.rowCount !== 1) throw new Error("erasure: the user row was not updated");
        });
        return true;
      } catch (err) {
        if (err instanceof AlreadyRequested) return false;
        throw err;
      }
    },
    start(userId) {
      // The streams first: an open stream must not outlive the 202 while the eraser waits for a slot (or a chat turn).
      try {
        o.closeStreams?.(userId);
      } catch {
        // the eraser's stop step closes them again
      }
      void o.eraser.run(userId); // run() never rejects
    },
    status: (receiptHash) => o.store.status(receiptHash),
  };
}
