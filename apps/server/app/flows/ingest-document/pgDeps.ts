import type { Pool } from "pg";
import type { IngestDeps } from "./deps";
import { PgStepGuard } from "./pgGuard";

export const pgIngestDeps = (pool: Pool): IngestDeps => ({ guard: new PgStepGuard(pool) });
