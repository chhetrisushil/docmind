import { Pool } from "pg";
import { positiveInt } from "../documents/limits";

/**
 * Refuses a connection that can see past row-level security. No migration uses FORCE ROW LEVEL
 * SECURITY, so the policies bind only roles that own nothing and bypass nothing. The connection is
 * refused when any of these holds: the session runs under a role other than the one it logged in
 * as (session_user differs from current_user, so RESET ROLE could widen it); the login or current
 * role is, or is a member of, a superuser or BYPASSRLS role; the current role owns, or is a member
 * of the owner of, any table with row-level security enabled; the current role can create roles or
 * is a member of any other role. A server started with the wrong
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
      WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user AND r.rolcreaterole)
        THEN 'it can create roles'
      WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
          WHERE m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
        THEN 'it is a member of another role'
    END AS reason`);
  const role = rows[0];
  if (role?.reason) {
    throw new Error(
      `database role "${role.name}" voids row-level security (${role.reason}): connect as the application's unprivileged role`,
    );
  }
}

/** node-postgres's own default, so a pool is the size it always was unless the operator sets one. */
export const DEFAULT_POOL_MAX = 10;

/** A pool size from `name` (`DOCMIND_APP_POOL_MAX`, `DOCMIND_LOOM_POOL_MAX`): 1 to 200, default 10. */
export function loadPoolMax(env: NodeJS.ProcessEnv, name: string): number {
  return positiveInt(env, name, DEFAULT_POOL_MAX, 200);
}

/** The pool the server uses for tenant data: connected as docmind_app, or it does not start. */
export async function createAppPool(
  connectionString: string,
  max = DEFAULT_POOL_MAX,
): Promise<Pool> {
  const pool = new Pool({ connectionString, max });
  // An idle connection dropped by the server must not crash the process.
  // The class only: a driver error message can carry a host or a user name.
  pool.on("error", (err) =>
    console.error(
      "idle database connection failed",
      err instanceof Error ? err.constructor.name : typeof err,
    ),
  );
  try {
    await assertUnprivilegedRole(pool);
  } catch (err) {
    await pool.end();
    throw err;
  }
  return pool;
}
