import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** `data/` at the repo root is git-ignored. */
export const DATA_DIR = resolve(__dirname, "../../../../data/loadtest");
export const STATE_FILE = resolve(DATA_DIR, "state.json");

export interface SeedUser {
  email: string;
  password: string;
  /** `name=value`, ready for a Cookie header. */
  cookie: string;
  documentIds: string[];
  chatIds: string[];
}

export interface SeedState {
  baseUrl: string;
  createdAt: string;
  users: SeedUser[];
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function loadState(): SeedState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SeedState;
  } catch {
    throw new Error("no seed state: run `pnpm --filter @docmind/loadtest seed` first");
  }
}
