import { parseArgs } from "node:util";
import { Api } from "./lib/api";
import { startSampler } from "./lib/sampler";
import { DATA_DIR, type SeedState, loadState, writeJson } from "./lib/state";
import { fmt, parseList, percentile, printTable } from "./lib/stats";

const { values } = parseArgs({
  options: {
    ramp: { type: "string", default: "5,10,25,50,100" },
    duration: { type: "string", default: "30" },
    "turn-timeout": { type: "string", default: "120" },
    "server-pid": { type: "string" },
  },
});
const state = loadState();
const api = new Api(state.baseUrl);
const turnTimeoutMs = Number(values["turn-timeout"]) * 1000;
const serverPid = values["server-pid"] ? Number(values["server-pid"]) : undefined;
/** The server allows 4 open chat streams per user. */
const STREAMS_PER_USER = 4;

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Server-sent events off a fetch body. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) as Record<string, unknown> };
    }
  }
}

interface Totals {
  ttft: number[];
  total: number[];
  resets: number;
  errors: Record<string, number>;
}

interface Turn {
  start: number;
  firstAnswer?: number;
  resets: number;
  done(outcome: string): void;
}

/** One virtual user: keeps its chat stream open and sends turns back to back until the deadline. */
async function virtualUser(
  cookie: string,
  chatId: string,
  deadline: number,
  t: Totals,
): Promise<void> {
  const fail = (kind: string) => {
    t.errors[kind] = (t.errors[kind] ?? 0) + 1;
  };
  const ac = new AbortController();
  let known = 0; // the highest turn number seen: history replayed on connect is not this run's
  let turn: Turn | undefined;
  let opened!: () => void;
  const connected = new Promise<void>((ok) => {
    opened = ok;
  });
  const res = await fetch(`${api.baseUrl}/api/chats/${chatId}/stream`, {
    headers: api.headers(cookie, { accept: "text/event-stream" }),
    signal: ac.signal,
  });
  if (!res.ok || !res.body) return void fail(`stream_${res.status}`);
  const pump = (async () => {
    try {
      for await (const f of frames(res.body as ReadableStream<Uint8Array>)) {
        if (f.event === "status") {
          known = Number(f.data.turns ?? 0);
          opened();
        } else if (f.event === "answer") {
          if (turn && turn.firstAnswer === undefined) turn.firstAnswer = performance.now();
        } else if (f.event === "reset") {
          if (turn) turn.resets++;
        } else if (f.event === "error") {
          turn?.done(`stream_error_${String(f.data.code)}`);
        } else if (f.event === "message") {
          const turnNo = Number(f.data.turn);
          if (f.data.role === "assistant" && turnNo > known) {
            known = turnNo;
            turn?.done(f.data.status === "complete" ? "ok" : `turn_${String(f.data.status)}`);
          }
        }
      }
      turn?.done("stream_closed");
    } catch {
      turn?.done("stream_closed");
    }
  })();
  await Promise.race([connected, pump]);

  while (performance.now() < deadline && !ac.signal.aborted) {
    const outcome = await new Promise<string>((resolve) => {
      const start = performance.now();
      const timer = setTimeout(() => resolve("timeout"), turnTimeoutMs);
      turn = {
        start,
        resets: 0,
        done: (o) => {
          clearTimeout(timer);
          resolve(o);
        },
      };
      fetch(`${api.baseUrl}/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: api.headers(cookie, { "content-type": "application/json" }),
        body: JSON.stringify({
          text: "What do my documents say about the budget and the next steps?",
        }),
      }).then(
        (r) => {
          if (r.status !== 202) turn?.done(`send_${r.status}`);
          return r.arrayBuffer();
        },
        () => turn?.done("send_failed"),
      );
    });
    const finished = turn as unknown as Turn;
    t.resets += finished.resets;
    if (outcome !== "ok") {
      fail(outcome);
      if (outcome === "stream_closed" || outcome === "timeout") break;
      continue;
    }
    t.total.push(performance.now() - finished.start);
    if (finished.firstAnswer !== undefined) t.ttft.push(finished.firstAnswer - finished.start);
  }
  ac.abort();
  await pump;
}

/** Virtual user k takes user k mod U and that user's next chat, so streams spread under the per-user cap. */
function assign(s: SeedState, k: number): { cookie: string; chatId: string } {
  const user = s.users[k % s.users.length];
  const chatId = user?.chatIds[Math.floor(k / s.users.length) % (user.chatIds.length || 1)];
  if (!user || !chatId) throw new Error("the seed state has no chats: re-run seed");
  return { cookie: user.cookie, chatId };
}

async function main(): Promise<void> {
  const perUser = Math.min(STREAMS_PER_USER, state.users[0]?.chatIds.length ?? 0);
  const cap = state.users.length * perUser;
  const rows: string[][] = [];
  const raw: unknown[] = [];
  for (const asked of parseList(values.ramp as string)) {
    const vus = Math.min(asked, cap);
    if (vus < asked)
      console.log(
        `${asked} turns need ${asked} chat streams; capped at ${cap} (seed more users or chats)`,
      );
    const t: Totals = { ttft: [], total: [], resets: 0, errors: {} };
    const stop = startSampler(api.baseUrl, serverPid);
    const t0 = performance.now();
    const deadline = t0 + Number(values.duration) * 1000;
    await Promise.all(
      Array.from({ length: vus }, (_, k) => {
        const { cookie, chatId } = assign(state, k);
        return virtualUser(cookie, chatId, deadline, t);
      }),
    );
    const elapsed = (performance.now() - t0) / 1000;
    const sample = await stop();
    const errors = Object.values(t.errors).reduce((a, b) => a + b, 0);
    const errorText =
      Object.entries(t.errors)
        .map(([k, n]) => `${k}:${n}`)
        .join(" ") || "-";
    rows.push([
      String(vus),
      String(t.total.length),
      fmt(t.total.length / elapsed, 2),
      fmt(percentile(t.ttft, 50), 0),
      fmt(percentile(t.ttft, 95), 0),
      fmt(percentile(t.ttft, 99), 0),
      fmt(percentile(t.total, 50), 0),
      fmt(percentile(t.total, 95), 0),
      fmt(percentile(t.total, 99), 0),
      String(t.resets),
      String(errors),
      fmt(sample.probeP99Ms),
      fmt(sample.cpuCores ?? Number.NaN, 2),
      errorText,
    ]);
    raw.push({ vus, elapsed, turns: t.total.length, ...t, sample });
    console.log(`${vus} concurrent turns done: ${t.total.length} turns, ${errors} errors`);
  }
  console.log("");
  printTable(
    [
      "turns",
      "done",
      "turns/s",
      "ttft p50",
      "p95",
      "p99",
      "full p50",
      "p95",
      "p99",
      "resets",
      "errors",
      "probe p99",
      "cpu",
      "error kinds",
    ],
    rows,
  );
  console.log(
    "\nms. ttft = POST /messages sent to the first answer frame on the stream; full = to the assistant message frame.",
  );
  const file = `${DATA_DIR}/chat-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeJson(file, raw);
  console.log(`results in ${file}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
