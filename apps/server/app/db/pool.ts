import { Pool } from "pg";

/**
 * Refuses a connection that can see past row-level security. No migration uses FORCE ROW LEVEL
 * SECURITY, so the policies bind only roles that own nothing and bypass nothing. The connection is
 * refused when any of these holds: the session runs under a role other than the one it logged in
 * as (session_user differs from current_user, so RESET ROLE could widen it); the login or current
 * role is, or is a member of, a superuser or BYPASSRLS role; the current role owns, or is a member
 * of the owner of, any table with row-level security enabled. A server started with the wrong
 * DATABASE_URL (the owner's, say) must not come up at all.
 */
export async function assertUnprivilegedRole(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ name: string; reason: string | null }>(`
    SELECT current_user AS name, CASE
      WHEN current_user <> session_user
        THEN 'the session runs under a role other than the one it logged in as'
      WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE (r.rolsuper OR r.rolbypassrls)
          AND (pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
            OR pg_catalog.pg_has_role(session_user, r.oid, 'MEMBER')))
        THEN 'it is, or is a member of, a superuser or BYPASSRLS role'
      WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relrowsecurity
          AND pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER'))
        THEN 'it owns, or is a member of the owner of, a table with row-level security'
    END AS reason`);
  const role = rows[0];
  if (role?.reason) {
    throw new Error(
      `database role "${role.name}" voids row-level security (${role.reason}): connect as docmind_app`,
    );
  }
}

/** The pool the server uses for tenant data: connected as docmind_app, or it does not start. */
export async function createAppPool(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString });
  // An idle connection dropped by the server must not crash the process.
  pool.on("error", (err) => console.error("idle database connection failed:", err.message));
  try {
    await assertUnprivilegedRole(pool);
  } catch (err) {
    await pool.end();
    throw err;
  }
  return pool;
}
