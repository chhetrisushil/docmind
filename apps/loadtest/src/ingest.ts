import { parseArgs } from "node:util";
import { Api, makeDocument, pool, sleep } from "./lib/api";
import { DATA_DIR, loadState, writeJson } from "./lib/state";
import { fmt, percentile } from "./lib/stats";

const { values } = parseArgs({
  options: {
    docs: { type: "string", default: "20" },
    concurrency: { type: "string", default: "8" },
    paragraphs: { type: "string", default: "40" },
    retries: { type: "string", default: "10" },
    users: { type: "string" },
  },
});
const state = loadState();
const api = new Api(state.baseUrl);
const total = Number(values.docs);
/** Fewer users means more uploads per user, which is how to meet the per-user limit. */
const users = state.users.slice(0, values.users ? Number(values.users) : undefined);

const uploadMs: number[] = [];
const readyMs: number[] = [];
let limited = 0; // 429 too_many_uploads: the per-user cap (DOCMIND_MAX_CONCURRENT_UPLOADS), counted, not a failure
let failed = 0;
let gaveUp = 0;

async function oneDocument(i: number): Promise<void> {
  const user = users[i % users.length];
  if (!user) throw new Error("the seed state has no users");
  const text = makeDocument(`ingest ${i}`, Number(values.paragraphs));
  const start = performance.now();
  let id: string | undefined;
  for (let attempt = 0; attempt <= Number(values.retries); attempt++) {
    const sent = performance.now();
    const res = await api.upload(
      user.cookie,
      `ingest-${Date.now()}-${i}.md`,
      "text/markdown",
      text,
    );
    if (res.status === 429) {
      limited++;
      await res.arrayBuffer();
      await sleep(1000);
      continue;
    }
    if (res.status !== 201) {
      failed++;
      await res.arrayBuffer();
      return;
    }
    uploadMs.push(performance.now() - sent);
    id = ((await res.json()) as { document: { id: string } }).document.id;
    break;
  }
  if (!id) return void gaveUp++;
  for (;;) {
    const { status } = await api.documentStatus(user.cookie, id);
    if (status === "ready") return void readyMs.push(performance.now() - start);
    if (status === "failed") return void failed++;
    await sleep(250);
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  await pool(
    Array.from({ length: total }, (_, i) => i),
    Number(values.concurrency),
    oneDocument,
  );
  const minutes = (performance.now() - t0) / 60_000;
  const out = {
    docs: total,
    concurrency: Number(values.concurrency),
    ready: readyMs.length,
    failed,
    gaveUp,
    uploadsLimited429: limited,
    docsPerMin: readyMs.length / minutes,
    uploadMs: { p50: percentile(uploadMs, 50), p95: percentile(uploadMs, 95) },
    uploadToReadyMs: {
      p50: percentile(readyMs, 50),
      p95: percentile(readyMs, 95),
      p99: percentile(readyMs, 99),
    },
  };
  console.log(
    `${out.ready}/${total} ready in ${fmt(minutes * 60)} s = ${fmt(out.docsPerMin)} docs/min`,
  );
  console.log(
    `upload request   p50 ${fmt(out.uploadMs.p50, 0)} ms  p95 ${fmt(out.uploadMs.p95, 0)} ms`,
  );
  console.log(
    `upload to ready  p50 ${fmt(out.uploadToReadyMs.p50, 0)} ms  p95 ${fmt(out.uploadToReadyMs.p95, 0)} ms  p99 ${fmt(out.uploadToReadyMs.p99, 0)} ms`,
  );
  console.log(`429 too_many_uploads: ${limited} (retried), failed: ${failed}, gave up: ${gaveUp}`);
  writeJson(`${DATA_DIR}/ingest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, out);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
