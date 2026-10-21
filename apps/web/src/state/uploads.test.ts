import type { DocumentDto } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { SseOptions } from "../api/sse";
import { AuthStore } from "./auth";
import { MAX_UPLOAD_BYTES, UploadsStore } from "./uploads";

const doc = (n: number): DocumentDto => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  title: `T${n}`,
  filename: `f${n}.pdf`,
  mime: "application/pdf",
  sizeBytes: 10,
  status: "uploaded",
  error: null,
  stats: null,
  summary: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
});
const file = (name: string, size = 3) => {
  const f = new File(["abc"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
};
async function signedIn() {
  const auth = new AuthStore({
    me: async () => ({}) as never,
    login: async () => ({}) as never,
  } as never);
  await auth.bootstrap();
  return auth;
}
function setup(
  upload = vi.fn(async (f: File) => ({ document: doc(f.name.length), duplicate: false })),
  auth?: AuthStore,
) {
  const sse: { opts?: SseOptions; closed: number } = { closed: 0 };
  const open = vi.fn((opts: SseOptions) => {
    sse.opts = opts;
    return {
      close: () => {
        sse.closed++;
      },
    };
  });
  const store = new UploadsStore({ uploadDocument: upload as never }, open as never, auth);
  const frame = (data: unknown, event = "progress") =>
    sse.opts?.onFrame({ event, data: JSON.stringify(data), id: undefined });
  return { store, upload, open, sse, frame };
}

describe("UploadsStore.upload", () => {
  it("refuses too large and unsupported files without a request, and uploads the rest in order", async () => {
    const t = setup();
    const out = await t.store.upload([
      file("big.pdf", MAX_UPLOAD_BYTES + 1),
      file("run.exe"),
      file("ok.TXT"),
    ]);
    expect(out.map((r) => r.reason ?? "ok")).toEqual(["too_large", "unsupported", "ok"]);
    expect(t.upload).toHaveBeenCalledTimes(1);
    expect(t.store.get().uploads.map((u) => [u.name, u.state, u.reason])).toEqual([
      ["big.pdf", "failed", "too_large"],
      ["run.exe", "failed", "unsupported"],
    ]);
  });
  it("reports progress on the item and removes it on success, keeping the duplicate flag", async () => {
    const t = setup(
      vi.fn(async (_f: File, o?: { onProgress?(p: number): void }) => {
        o?.onProgress?.(40);
        return { document: doc(1), duplicate: true };
      }),
    );
    const seen: number[] = [];
    t.store.subscribe((s) => {
      const u = s.uploads[0];
      if (u?.state === "uploading") seen.push(u.percent);
    });
    const [r] = await t.store.upload([file("a.pdf")]);
    expect(r).toMatchObject({ duplicate: true, document: { id: doc(1).id } });
    expect(seen).toContain(40);
    expect(t.store.get().uploads).toEqual([]);
  });
  it.each([
    [new ApiError(403, "quota_exceeded"), "quota"],
    [new ApiError(413, "too_large"), "too_large"],
    [new ApiError(415, "unsupported_type"), "unsupported"],
    [new ApiError(0, "network"), "network"],
    [new ApiError(500, "internal"), "server"],
    [new TypeError("x"), "server"],
  ])("a failure %# keeps its item with the reason %s", async (err, reason) => {
    const t = setup(
      vi.fn(async () => {
        throw err;
      }),
    );
    const [r] = await t.store.upload([file("a.pdf")]);
    expect(r?.reason).toBe(reason);
    expect(t.store.get().uploads[0]).toMatchObject({ state: "failed", reason });
    t.store.dismissUpload(t.store.get().uploads[0]?.key as string);
    expect(t.store.get().uploads).toEqual([]);
  });
  it("runs at most two uploads at once", async () => {
    let live = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const t = setup(
      vi.fn(async (f: File) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => gates.push(r));
        live--;
        return { document: doc(f.name.length), duplicate: false };
      }),
    );
    const done = t.store.upload(["a.pdf", "bb.pdf", "ccc.pdf", "dddd.pdf"].map((n) => file(n)));
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(i));
      gates[i]?.();
    }
    await done;
    expect(peak).toBe(2);
  });
});

describe("UploadsStore cancel", () => {
  const hang = () => {
    const signals: AbortSignal[] = [];
    const fn = vi.fn(
      (_f: File, o?: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          const s = o?.signal as AbortSignal;
          signals.push(s);
          s.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    return { fn, signals };
  };
  it("cancelling an item aborts its request and drops it without a failure", async () => {
    const h = hang();
    const t = setup(h.fn as never);
    const done = t.store.upload([file("a.pdf")]);
    await vi.waitFor(() => expect(h.signals).toHaveLength(1));
    t.store.cancel(t.store.get().uploads[0]?.key as string);
    expect(h.signals[0]?.aborted).toBe(true);
    const [r] = await done;
    expect(r?.reason).toBe("cancelled");
    expect(t.store.get().uploads).toEqual([]);
  });
  it("cancelling a queued item means it is never requested", async () => {
    const h = hang();
    const t = setup(h.fn as never);
    const done = t.store.upload(["a.pdf", "b.pdf", "c.pdf"].map((n) => file(n)));
    await vi.waitFor(() => expect(h.signals).toHaveLength(2));
    t.store.cancel(t.store.get().uploads[2]?.key as string);
    t.store.cancelAll();
    const out = await done;
    expect(out.map((r) => r.reason)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(h.fn).toHaveBeenCalledTimes(2);
    expect(t.store.get().uploads).toEqual([]);
  });
  it("signing out cancels every upload, clears the queue and closes the event stream", async () => {
    const auth = await signedIn();
    const h = hang();
    const t = setup(h.fn as never, auth);
    t.store.startEvents(() => {});
    const done = t.store.upload([file("a.pdf"), file("run.exe")]);
    await vi.waitFor(() => expect(h.signals).toHaveLength(1));
    auth.signedOut();
    expect(h.signals[0]?.aborted).toBe(true);
    await done;
    expect(t.store.get().uploads).toEqual([]);
    expect(t.sse.closed).toBe(1);
  });
});

describe("UploadsStore events", () => {
  it("passes valid progress frames on, ignores junk, and asks for a resync after a reconnect", () => {
    const t = setup();
    const heard: unknown[] = [];
    t.store.startEvents((e) => heard.push(e));
    t.store.startEvents(() => heard.push("second")); // already open: ignored
    const id = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
    t.sse.opts?.onOpen?.();
    t.frame({ documentId: id, step: "parse", status: "parsing" });
    t.frame({ documentId: "nope", status: "parsing" });
    t.sse.opts?.onFrame({ event: "progress", data: "{not json", id: undefined });
    t.frame({ documentId: id, status: "ready", step: "finalize" }, "other");
    t.sse.opts?.onOpen?.(); // the second open is a reconnect
    expect(heard).toEqual([{ documentId: id, step: "parse", status: "parsing" }, "resync"]);
    t.store.stopEvents();
    expect(t.sse.closed).toBe(1);
  });
  it("a 401 ends the session it was opened in, and a late one for an older session does not", async () => {
    const auth = await signedIn();
    const expired = vi.spyOn(auth, "expired");
    const t = setup(undefined, auth);
    const ended = vi.fn();
    t.store.startEvents(() => {}, ended);
    const epoch = auth.epoch;
    t.sse.opts?.onClose?.("unauthorized");
    expect(expired).toHaveBeenCalledWith(epoch);
    expect(ended).toHaveBeenCalledWith("unauthorized");
    expect(auth.get().status).toBe("anonymous");
    // a stream from the old session closing after a new sign-in must not sign the new session out
    const t2 = setup(undefined, auth);
    t2.store.startEvents(() => {});
    await auth.bootstrap();
    t2.sse.opts?.onClose?.("unauthorized");
    expect(auth.get().status).toBe("signed-in");
  });
  it("a failed or closed stream is reported to the caller by reason only and can be started again", () => {
    const t = setup();
    const ended = vi.fn();
    t.store.startEvents(() => {}, ended);
    t.sse.opts?.onClose?.("failed");
    expect(ended).toHaveBeenCalledWith("failed");
    t.store.startEvents(() => {}, ended);
    expect(t.open).toHaveBeenCalledTimes(2);
  });
});

describe("UploadsStore lifetime and limits", () => {
  it("the concurrency limit is store-wide: two drops never run more than two at once", async () => {
    let live = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const t = setup(
      vi.fn(async (f: File) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => gates.push(r));
        live--;
        return { document: doc(f.name.length), duplicate: false };
      }),
    );
    const a = t.store.upload([file("a.pdf"), file("bb.pdf")]);
    const b = t.store.upload([file("ccc.pdf"), file("dddd.pdf")]);
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(i));
      gates[i]?.();
    }
    await Promise.all([a, b]);
    expect(peak).toBe(2);
    expect(t.upload).toHaveBeenCalledTimes(4);
  });
  it("tells onSettled listeners when a batch is done, and stops after unsubscribe", async () => {
    const t = setup();
    const heard = vi.fn();
    const off = t.store.onSettled((r) => heard(r.length));
    await t.store.upload([file("a.pdf"), file("b.pdf")]);
    expect(heard).toHaveBeenCalledWith(2);
    off();
    await t.store.upload([file("c.pdf")]);
    expect(heard).toHaveBeenCalledTimes(1);
  });
  it("a deliberate stopEvents does not report an end, and a late close of the old stream is ignored", () => {
    const t = setup();
    const ended = vi.fn();
    t.store.startEvents(() => {}, ended);
    const first = t.sse.opts;
    t.store.stopEvents();
    first?.onClose?.("closed");
    expect(ended).not.toHaveBeenCalled();
    t.store.startEvents(() => {}, ended);
    first?.onClose?.("failed");
    expect(ended).not.toHaveBeenCalled();
  });
  it("a stream that closes while open() is still running is handled, and can be started again", () => {
    const sse = { closes: 0 };
    const open = vi.fn((opts: SseOptions) => {
      opts.onClose?.("failed"); // before open() has returned
      return { close: () => void sse.closes++ };
    });
    const store = new UploadsStore({ uploadDocument: vi.fn() as never }, open as never);
    const ended = vi.fn();
    store.startEvents(() => {}, ended);
    expect(ended).toHaveBeenCalledWith("failed");
    store.startEvents(() => {}, ended);
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("a run that throws cannot hang upload() or keep the pool slot", async () => {
    const t = setup();
    const patch = vi.spyOn(t.store as never, "patch" as never).mockImplementation((() => {
      throw new Error("boom");
    }) as never);
    await expect(t.store.upload([file("a.pdf")])).resolves.toHaveLength(1);
    patch.mockRestore();
    const out = await t.store.upload([file("b.pdf"), file("c.pdf"), file("d.pdf")]);
    expect(out.every((r) => r.document)).toBe(true);
  });
  it("a new sign-in without a sign-out in between also cancels and clears", async () => {
    const auth = await signedIn();
    const t = setup(undefined, auth);
    t.store.startEvents(() => {});
    await t.store.upload([file("run.exe")]);
    expect(t.store.get().uploads).toHaveLength(1);
    await auth.login({ email: "a", password: "b" } as never);
    expect(t.store.get().uploads).toEqual([]);
    expect(t.sse.closed).toBe(1);
  });
});
