import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HashingEmbeddingProvider } from "@loom/memory";

export interface FakeOllama {
  url: string;
  /** Input count of each answered request. Counts only, never the texts. */
  batches: number[];
  close(): Promise<void>;
  failNext(status: number): void;
  /** Parks the next request at a gate; resolves when one has arrived there. */
  hold(): Promise<void>;
  /** Opens the gate and lets parked requests answer. */
  release(): void;
  /** Resolves when a request's connection closes before its answer was sent (the caller aborted). */
  nextAbort(): Promise<void>;
}

const MAX_BODY = 8 * 1024 * 1024;
/** A hook that never fires fails the test instead of hanging it. */
const HOOK_WAIT_MS = 10_000;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(what: string): Deferred {
  let resolve: () => void = () => {};
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => {
      clearTimeout(timer);
      res();
    };
    timer = setTimeout(() => rej(new Error(`fake Ollama: ${what} never happened`)), HOOK_WAIT_MS);
    timer.unref();
  });
  return { promise, resolve };
}

export async function startFakeOllama(options: {
  dimensions: number;
  model?: string;
}): Promise<FakeOllama> {
  const model = options.model ?? "fake-embed";
  const embedder = new HashingEmbeddingProvider({ dimensions: options.dimensions });
  const batches: number[] = [];
  const failures: number[] = [];
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  let arrived: Deferred | null = null;
  let aborted: Deferred | null = null;
  const server = createServer((req, res) => {
    res.on("close", () => {
      if (!res.writableFinished) aborted?.resolve();
    });
    if (req.method !== "POST" || req.url !== "/api/embed") {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      void answer(Buffer.concat(chunks).toString("utf8")).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    async function answer(raw: string): Promise<void> {
      const failure = failures.shift();
      if (failure) return void res.writeHead(failure).end();
      const body = JSON.parse(raw) as { model: string; input: string[] };
      if (body.model !== model) return void res.writeHead(404).end();
      if (gate) {
        arrived?.resolve();
        await gate;
      }
      if (res.destroyed) return; // the caller left while parked: nothing to answer
      batches.push(body.input.length);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: await embedder.embed(body.input) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const release = () => {
    open();
    gate = null;
  };
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    batches,
    failNext: (status) => void failures.push(status),
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      arrived = deferred("a request reaching the gate");
      return arrived.promise;
    },
    release,
    nextAbort() {
      aborted = deferred("a request being aborted");
      return aborted.promise;
    },
    close: () =>
      new Promise<void>((resolve) => {
        release(); // a parked request must not outlive the server
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
