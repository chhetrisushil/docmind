import { parseArgs } from "node:util";
import autocannon from "autocannon";
import { Api } from "./lib/api";
import { startSampler } from "./lib/sampler";
import { DATA_DIR, loadState, writeJson } from "./lib/state";
import { fmt, parseList, printTable } from "./lib/stats";

const { values } = parseArgs({
  options: {
    connections: { type: "string", default: "50" },
    steps: { type: "string" },
    duration: { type: "string", default: "10" },
    routes: { type: "string" },
    "server-pid": { type: "string" },
  },
});
const state = loadState();
const api = new Api(state.baseUrl);
const duration = Number(values.duration);
const serverPid = values["server-pid"] ? Number(values["server-pid"]) : undefined;
const steps = values.steps ? parseList(values.steps) : [Number(values.connections)];

interface Req {
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  body?: string;
}

// The handles each page asks for (packages/experiences/src/views.ts); the page sends them in one hydrate call.
const HANDLES = {
  library: ["doc-total", "doc-ready", "ingest", "documents"],
  detail: [
    "doc-status",
    "doc-summary",
    "doc-words",
    "doc-pages",
    "doc-minutes",
    "doc-facts",
    "doc-type",
    "doc-source",
  ],
  sessions: ["chats"],
} as const;

interface ViewInfo {
  experienceId: string;
  versionHash: string;
}

async function viewInfo(view: string, cookie: string): Promise<ViewInfo> {
  const { experienceId, versionHash } = await api.json<ViewInfo>(
    `/api/ui/views/${view}?surface=web`,
    cookie,
  );
  return { experienceId, versionHash };
}

/** One request per user per route; autocannon cycles through the list on every connection. */
async function buildRoutes(): Promise<Record<string, Req[]>> {
  const cookie0 = state.users[0]?.cookie as string;
  const views = {
    library: await viewInfo("library", cookie0),
    detail: await viewInfo("detail", cookie0),
    sessions: await viewInfo("sessions", cookie0),
  };
  const hydrate = (
    view: keyof typeof HANDLES,
    cookie: string,
    params: Record<string, string> = {},
  ): Req => ({
    method: "POST",
    path: "/api/ui/hydrate",
    headers: api.headers(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({
      view,
      requests: HANDLES[view].map((handle) => ({ ...views[view], handle, params })),
    }),
  });
  const get = (path: string, cookie: string): Req => ({
    method: "GET",
    path,
    headers: api.headers(cookie),
  });
  const routes: Record<string, Req[]> = {
    me: [],
    "documents-list": [],
    "document-detail": [],
    "chats-list": [],
    "ui-view": [],
    "hydrate-library": [],
    "hydrate-detail": [],
    "hydrate-sessions": [],
  };
  for (const u of state.users) {
    const docId = u.documentIds[0] as string;
    routes.me?.push(get("/api/me", u.cookie));
    routes["documents-list"]?.push(get("/api/documents?limit=50", u.cookie));
    routes["document-detail"]?.push(get(`/api/documents/${docId}`, u.cookie));
    routes["chats-list"]?.push(get("/api/chats", u.cookie));
    routes["ui-view"]?.push(get("/api/ui/views/library?surface=web", u.cookie));
    routes["hydrate-library"]?.push(hydrate("library", u.cookie));
    routes["hydrate-detail"]?.push(hydrate("detail", u.cookie, { id: docId }));
    routes["hydrate-sessions"]?.push(hydrate("sessions", u.cookie));
  }
  return routes;
}

/** A hydrate call that answers 200 can still carry a failed handle; check once so the load is a real page load. */
async function checkHydrate(routes: Record<string, Req[]>): Promise<void> {
  for (const name of ["hydrate-library", "hydrate-detail", "hydrate-sessions"]) {
    const r = routes[name]?.[0] as Req;
    const res = await fetch(`${api.baseUrl}${r.path}`, {
      method: "POST",
      headers: r.headers,
      body: r.body,
    });
    const out = (await res.json()) as { results?: { state?: string }[] };
    const states = (out.results ?? []).map((x) => x.state);
    if (res.status !== 200 || states.some((s) => s !== "ready"))
      throw new Error(`${name}: hydrate did not answer ready (${res.status} ${states.join(",")})`);
  }
}

interface Row {
  route: string;
  connections: number;
  rps: number;
  p50: number;
  p90: number;
  p97_5: number;
  p99: number;
  max: number;
  non2xx: number;
  errors: number;
  timeouts: number;
  probeP99Ms: number;
  cpuCores?: number;
  peakRssMb?: number;
}

async function measure(route: string, requests: Req[], connections: number): Promise<Row> {
  const stop = startSampler(api.baseUrl, serverPid);
  const r = await autocannon({ url: api.baseUrl, connections, duration, timeout: 30, requests });
  const sample = await stop();
  return {
    route,
    connections,
    rps: r.requests.total / r.duration,
    p50: r.latency.p50,
    p90: r.latency.p90,
    p97_5: r.latency.p97_5,
    p99: r.latency.p99,
    max: r.latency.max,
    non2xx: r.non2xx,
    errors: r.errors,
    timeouts: r.timeouts,
    probeP99Ms: sample.probeP99Ms,
    ...(sample.cpuCores !== undefined && { cpuCores: sample.cpuCores }),
    ...(sample.peakRssMb !== undefined && { peakRssMb: sample.peakRssMb }),
  };
}

async function main(): Promise<void> {
  const routes = await buildRoutes();
  await checkHydrate(routes);
  const wanted = values.routes ? values.routes.split(",") : [...Object.keys(routes), "mixed"];
  // The mix interleaves every route per user, like the requests of a few page loads.
  const all = Object.values(routes);
  routes.mixed = Array.from({ length: state.users.length }, (_, u) =>
    all.map((l) => l[u] as Req),
  ).flat();
  const rows: Row[] = [];
  for (const connections of steps) {
    for (const route of wanted) {
      const requests = routes[route];
      if (!requests)
        throw new Error(`unknown route ${route}; known: ${Object.keys(routes).join(", ")}`);
      const row = await measure(route, requests, connections);
      rows.push(row);
      console.log(`${route} @${connections}: ${fmt(row.rps, 0)} req/s, p99 ${fmt(row.p99, 0)} ms`);
    }
  }
  console.log("");
  printTable(
    [
      "route",
      "conns",
      "req/s",
      "p50 ms",
      "p90 ms",
      "p97.5 ms",
      "p99 ms",
      "max ms",
      "non2xx",
      "errors",
      "probe p99",
      "cpu",
      "rss MB",
    ],
    rows.map((r) => [
      r.route,
      String(r.connections),
      fmt(r.rps, 0),
      fmt(r.p50),
      fmt(r.p90),
      fmt(r.p97_5),
      fmt(r.p99),
      fmt(r.max, 0),
      String(r.non2xx),
      String(r.errors + r.timeouts),
      fmt(r.probeP99Ms),
      fmt(r.cpuCores ?? Number.NaN, 2),
      fmt(r.peakRssMb ?? Number.NaN, 0),
    ]),
  );
  console.log(
    "\nprobe p99 = GET /healthz latency seen from a separate thread (event-loop delay); cpu = server cores busy (with --server-pid).",
  );
  const file = `${DATA_DIR}/read-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeJson(file, { duration, rows });
  console.log(`results in ${file}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
