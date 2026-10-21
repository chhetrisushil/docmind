import { describe, expect, it } from "vitest";
import { createServices } from "./services";

const ME = {
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  email: "a@example.com",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createServices", () => {
  it("a 401 for a request of a finished session does not sign out the new session", async () => {
    let lateAnswer: (r: Response) => void = () => {};
    const fetch = (async (url: string) => {
      if (String(url).endsWith("/api/auth/login")) return json(ME);
      if (String(url).endsWith("/api/auth/logout")) return new Response(null, { status: 204 });
      return new Promise<Response>((r) => {
        lateAnswer = r;
      }); // /api/me, held back
    }) as never;
    const svc = createServices({ fetch });
    await svc.auth.login({ email: "a@example.com", password: "x" });
    const old = svc.api.me().catch(() => {}); // sent in the first session
    await svc.auth.logout();
    await svc.auth.login({ email: "a@example.com", password: "x" }); // a second session
    lateAnswer(json({ error: { code: "unauthorized", message: "x" } }, 401));
    await old;
    expect(svc.auth.get().status).toBe("signed-in");
  });

  it("a 401 for a request of the current session signs out", async () => {
    const fetch = (async (url: string) =>
      String(url).endsWith("/api/auth/login")
        ? json(ME)
        : json({ error: { code: "unauthorized", message: "x" } }, 401)) as never;
    const svc = createServices({ fetch });
    await svc.auth.login({ email: "a@example.com", password: "x" });
    await svc.api.me().catch(() => {});
    expect(svc.auth.get().status).toBe("anonymous");
  });
});
