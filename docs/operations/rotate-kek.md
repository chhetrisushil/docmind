# Rotating the master key (KEK)

Every user's data key is stored wrapped by the KEK (`data_keys.kek_id` names which one). Rotation
re-wraps each stored key under a new KEK. It does **not** change any data key, so no event, snapshot or
blob is rewritten, and it does not help if a data key itself leaked (that needs re-encryption, which
v1 does not have).

Rotate on a schedule, when someone with access to the KEK leaves, and at once if the KEK may have leaked.

## Before you start

- A database backup, and the old KEK safe in your secret store.
- The migration (owner) role's URL: the tool reads and updates `data_keys`, which `docmind_app` cannot.
- Every server instance can be restarted.

## Steps

1. **Make the new KEK.** `openssl rand -base64 32`. Pick an id that was never used, for example `kek-2`.
2. **Run servers with both.** Set on every instance and restart:
   `DOCMIND_KEK=<new>`, `DOCMIND_KEK_ID=kek-2`, `DOCMIND_KEK_PREVIOUS=<old>`, `DOCMIND_KEK_PREVIOUS_ID=kek-1`.
   New users' keys are now wrapped by the new KEK, and old keys still open with the previous one.
   Restart **all** instances together on the new set, or first load both KEKs on every instance before
   any re-wrap: during a rolling restart an instance still on the old set cannot open keys the new
   instances wrapped.
   Double-check that **both** `DOCMIND_KEK_PREVIOUS` and `DOCMIND_KEK_PREVIOUS_ID` are set: a stray
   `DOCMIND_KEK_PREVIOUS_ID` without `DOCMIND_KEK_PREVIOUS` makes the server refuse to start.
3. **Re-wrap.** From a machine that can reach the database, with the same four variables set:
   ```bash
   DOCMIND_MIGRATE_URL=postgres://<owner>@<host>/docmind pnpm --filter @docmind/server keys:rotate
   ```
   It prints `rotated N key(s) to kek-2`, then `M key(s) open with kek-2 alone; 0 on another KEK; 0 do not open`,
   and exits 0. It is safe to stop (Ctrl-C) and to run again: each batch of 100 is one transaction, a key
   already on the new KEK is skipped, and tombstones (erased users) are never touched. Its output is counts
   and subject ids only, never key material.
4. **If it exits 1,** read the lines it printed. The command exits 1 on any failed row, any remaining row,
   or a failed verify. `FAILED to open the key of <user>` means that row does not open under the KEK it names
   (corruption, or the wrong previous KEK): the row is left as it was; fix the cause and run again.
   `K key(s) still wrapped by <id>` means keys under a KEK you did not provide: add it as the previous KEK
   and run again. Do not go on until the run is clean.
5. **Verify on its own.** `... pnpm --filter @docmind/server keys:rotate -- --verify-only` must exit 0.
6. **Remove the previous KEK from the environment.** Delete `DOCMIND_KEK_PREVIOUS*` and restart every instance.
7. **Retire the old KEK last.** Keep the old KEK (offline, in your secret store) until backups taken before
   step 3 have expired (30 days by default, spec §4.4), then destroy it. Restoring such a backup needs it.

## Destroying a user's key, and what it does not erase

Destroying a user's key overwrites the live row with a tombstone. It does **not** erase older copies of
the wrapped key: those remain in dead row versions (until `VACUUM`), in WAL and archives, and in backups,
and the current KEK still opens them. So real crypto-shredding takes two things:

- Run `VACUUM data_keys` after destroys (recommended) to reclaim dead row versions.
- Rotate to a new KEK, then retire the old KEK once the backup and WAL retention window has passed. Only
  then are the old wrapped copies unreadable.

If the old KEK leaked, steps 1-6 protect the live database, but a leaked backup from before the rotation can
still be opened with it. That is why backup retention is bounded.
