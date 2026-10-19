import { vi } from "vitest";
import { PG_URL, withRoleLock } from "./app/db/testSupport";

// Tests only: serialize migrations and ALTER ROLE (cluster-global) across concurrent test processes. Production's
// setRolePassword is untouched.
vi.mock("./app/db/migrate", async (importOriginal) => {
  const real = await importOriginal<typeof import("./app/db/migrate")>();
  const setRolePassword: typeof real.setRolePassword = (pool, role, password) =>
    PG_URL
      ? withRoleLock(() => real.setRolePassword(pool, role, password))
      : real.setRolePassword(pool, role, password);
  // Migrations also CREATE/ALTER/GRANT the cluster-global roles.
  // Only the real migrations touch roles; a runner test on a temp dir must contend on the runner's own lock.
  const migrate: typeof real.migrate = (pool, dir) =>
    PG_URL && (dir === undefined || dir === real.MIGRATIONS_DIR)
      ? withRoleLock(() => real.migrate(pool, dir))
      : real.migrate(pool, dir);
  return {
    ...real,
    migrate,
    setRolePassword,
    setAppRolePassword: (pool: Parameters<typeof real.setRolePassword>[0], password: string) =>
      setRolePassword(pool, "docmind_app", password),
  };
});
