import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Api, makeDocument, pool, sleep } from "./lib/api";
import { STATE_FILE, type SeedState, type SeedUser, writeJson } from "./lib/state";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.LOADTEST_URL ?? "http://127.0.0.1:3000" },
    users: { type: "string", default: "20" },
    chats: { type: "string", default: "5" },
    "text-docs": { type: "string", default: "2" },
    concurrency: { type: "string", default: "4" },
    prefix: { type: "string", default: "loadtest" },
  },
});
const api = new Api(values.url as string);
const userCount = Number(values.users);
const chatsPerUser = Number(values.chats);
const textDocs = Number(values["text-docs"]);

// A real PDF from the parser fixtures, when the checkout has it.
const pdfPath = resolve(__dirname, "../../../packages/parsers/test-fixtures/two-pages.pdf");

/** Sign-up has no email verification, so the same addresses can be reused across runs: login just works. */
async function seedUser(n: number): Promise<SeedUser> {
  const email = `${values.prefix}-${n}@example.test`;
  const password = "loadtest-password-1234";
  const ip = `10.77.${Math.floor(n / 250)}.${(n % 250) + 1}`;
  await api.signUp(email, password, ip);
  const cookie = await api.logIn(email, password, ip);
  const documentIds: string[] = [];
  const files: { name: string; mime: string; body: string | Uint8Array }[] = [];
  for (let d = 0; d < textDocs; d++)
    files.push({
      name: `notes-${n}-${d}.md`,
      mime: "text/markdown",
      body: makeDocument(`User ${n} notes ${d} ${randomUUID().slice(0, 8)}`),
    });
  // A PDF is byte-identical for every user but dedup is per user, so each user gets it once.
  if (existsSync(pdfPath))
    files.push({ name: "two-pages.pdf", mime: "application/pdf", body: readFileSync(pdfPath) });
  for (const f of files) {
    const res = await api.upload(cookie, f.name, f.mime, f.body);
    if (res.status !== 201 && res.status !== 200) throw new Error(`upload -> ${res.status}`);
    documentIds.push(((await res.json()) as { document: { id: string } }).document.id);
  }
  const chatIds: string[] = [];
  for (let c = 0; c < chatsPerUser; c++) chatIds.push(await api.createChat(cookie));
  return { email, password, cookie, documentIds, chatIds };
}

async function waitReady(user: SeedUser): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (const id of user.documentIds) {
    for (;;) {
      const { status } = await api.documentStatus(user.cookie, id);
      if (status === "ready") break;
      if (status === "failed") throw new Error(`${user.email}: a document failed to ingest`);
      if (Date.now() > deadline) throw new Error(`${user.email}: documents not ready in 180 s`);
      await sleep(500);
    }
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const users: SeedUser[] = new Array(userCount);
  await pool(
    Array.from({ length: userCount }, (_, n) => n),
    Number(values.concurrency),
    async (n) => {
      users[n] = await seedUser(n);
    },
  );
  console.log(
    `${userCount} users signed up, documents uploaded, ${chatsPerUser} chats each; waiting for ingestion`,
  );
  await pool(users, Number(values.concurrency), waitReady);
  const state: SeedState = { baseUrl: api.baseUrl, createdAt: new Date().toISOString(), users };
  writeJson(STATE_FILE, state);
  console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)} s, state in ${STATE_FILE}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
