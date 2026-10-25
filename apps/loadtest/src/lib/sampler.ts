import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { percentile } from "./stats";

const run = promisify(execFile);

export interface Sample {
  /** Latency of GET /healthz every 100 ms, from a separate thread: it queues behind the server's event loop. */
  probeP50Ms: number;
  probeP99Ms: number;
  probeMaxMs: number;
  /** Server CPU use as a share of one core (needs the server pid), and its peak resident memory. */
  cpuCores?: number;
  peakRssMb?: number;
}

// Runs in its own thread, so the load generator's busy loop cannot inflate what it measures.
const PROBE = `
const { parentPort, workerData } = require("node:worker_threads");
const lat = [];
let stop = false;
parentPort.on("message", () => { stop = true; });
(async () => {
  while (!stop) {
    const t = performance.now();
    try { await (await fetch(workerData.url)).arrayBuffer(); lat.push(performance.now() - t); } catch {}
    await new Promise((ok) => setTimeout(ok, 100));
  }
  parentPort.postMessage(lat);
})();
`;

/** "1:02:03.45" or "12:03.45" (ps cputime) to seconds. */
const seconds = (t: string): number =>
  t
    .trim()
    .split(":")
    .reduce((s, p) => s * 60 + Number(p), 0);

async function psSample(pid: number): Promise<{ cpu: number; rssKb: number } | undefined> {
  try {
    const { stdout } = await run("ps", ["-o", "time=,rss=", "-p", String(pid)]);
    const [time, rss] = stdout.trim().split(/\s+/);
    return { cpu: seconds(time ?? "0"), rssKb: Number(rss) };
  } catch {
    return undefined; // the process is gone
  }
}

/** Starts the health probe and, with a pid, the process sampler. `stop()` returns what they saw. */
export function startSampler(baseUrl: string, pid?: number): () => Promise<Sample> {
  const worker = new Worker(PROBE, { eval: true, workerData: { url: `${baseUrl}/healthz` } });
  const latencies = new Promise<number[]>((ok) => worker.once("message", ok));
  const t0 = Date.now();
  let first: { cpu: number } | undefined;
  let last: { cpu: number } | undefined;
  let peakKb = 0;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (pid === undefined) return;
    const s = await psSample(pid);
    if (!s) return;
    first ??= s;
    last = s;
    peakKb = Math.max(peakKb, s.rssKb);
  };
  void tick();
  if (pid !== undefined) timer = setInterval(() => void tick(), 1000);
  return async () => {
    clearInterval(timer);
    await tick();
    worker.postMessage("stop");
    const lat = (await latencies).slice(1); // the first request pays for the thread's own warm-up
    await worker.terminate();
    const elapsed = (Date.now() - t0) / 1000;
    return {
      probeP50Ms: percentile(lat, 50),
      probeP99Ms: percentile(lat, 99),
      probeMaxMs: Math.max(0, ...lat),
      ...(first && last && { cpuCores: (last.cpu - first.cpu) / elapsed }),
      ...(pid !== undefined && { peakRssMb: peakKb / 1024 }),
    };
  };
}
