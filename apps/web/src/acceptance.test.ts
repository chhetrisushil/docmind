import { describe, expect, it, vi } from "vitest";
import { Router } from "./router";
import { createServices } from "./services";
import { deepAll, deepFind, deepText, unnamedControls } from "./testing/dom";
import { FakeServer } from "./testing/fakeServer";
import "./components";

// Obviously fake values; the test fails if any of them is ever logged, stored or sent in a URL.
const SENTINEL = {
  email: "ada.sentinel@example.com",
  password: "sentinel-password-0123456789",
  file: "sentinel-contract.pdf",
  title: "sentinel-contract",
  question: "sentinel-question: when is payment due?",
};
const wait = (check: () => unknown) => vi.waitFor(check, { timeout: 8000 });
const SCENARIO_TIMEOUT = 30_000;

function boot(server: FakeServer, path: string) {
  const win = {
    location: { pathname: path, search: "" },
    history: {
      pushState: (_s: unknown, _t: string, u: string) => {
        const url = new URL(u, "http://fake.test");
        win.location.pathname = url.pathname;
        win.location.search = url.search;
      },
      replaceState: (_s: unknown, _t: string, u: string) => {
        const url = new URL(u, "http://fake.test");
        win.location.pathname = url.pathname;
        win.location.search = url.search;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const services = createServices({
    fetch: server.fetch,
    xhr: () => server.xhr(),
    router: new Router(win as never),
  });
  const app = document.createElement("dm-app") as HTMLElement & { services: typeof services };
  app.services = services;
  document.body.append(app);
  return { app, services };
}
const find = (root: ParentNode, selector: string) => deepFind(root, selector) as HTMLElement;
const text = (root: ParentNode) => deepText(root).replace(/\s+/g, " ");
const labelled = (root: ParentNode, selector: string, label: string) =>
  deepAll(root, selector).find((e) => e.getAttribute("aria-label") === label) as
    | HTMLButtonElement
    | undefined;
const follow = (a: Element) =>
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
const type = (input: Element, value: string) => {
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = (form: Element) =>
  form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
const route = (p: ReturnType<typeof boot>) => p.services.router.get();

describe("M6 acceptance", () => {
  it(
    "sign up, upload a document, ask about it, read the cited answer, reload, rename the chat, then delete the account",
    async () => {
      const logged: string[] = [];
      for (const level of ["log", "info", "warn", "error", "debug"] as const)
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(" "));
        });
      const server = new FakeServer();
      // A desktop-width window: the sources panel is docked beside the chat (happy-dom's default window is narrower than 1100px).
      vi.stubGlobal("matchMedia", (q: string) => ({
        matches: q.includes("1100px"),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));

      // 1. A visitor with no session is sent to sign in.
      let page = boot(server, "/documents");
      await wait(() => expect(route(page)).toEqual({ name: "sign-in" }));
      await wait(() => expect(find(page.app, "form")).not.toBeNull());
      expect(unnamedControls(page.app)).toEqual([]);

      // 2. Sign up. Sign-up answers 202, the app signs in, and the first chat screen opens inside the shell, with the chat list beside it.
      page.services.router.navigate({ name: "sign-up" });
      await wait(() => expect(text(page.app)).toContain("Create your account"));
      type(find(page.app, "input[type=email]"), SENTINEL.email);
      type(find(page.app, "input[name=password]"), SENTINEL.password);
      submit(find(page.app, "form"));
      await wait(() => expect(route(page)).toEqual({ name: "chat" }));
      await wait(() => expect(find(page.app, "dm-sessions")).not.toBeNull());
      await wait(() => expect(find(page.app, "lu-chat")).not.toBeNull());
      expect(unnamedControls(page.app)).toEqual([]);

      // 3. The library is empty (a loom-ui Note); upload a file; it becomes Ready on the live stream, in a loom-ui Table.
      follow(find(page.app, "a[data-documents]"));
      await wait(() => expect(route(page)).toEqual({ name: "documents" }));
      await wait(() => expect(text(page.app)).toContain("No documents yet"));
      const zone = find(page.app, "dm-upload-zone");
      const input = zone.shadowRoot?.querySelector("input[type=file]") as HTMLInputElement;
      Object.defineProperty(input, "files", {
        value: [new File(["%PDF-1.7 fake"], SENTINEL.file)],
        configurable: true,
      });
      input.dispatchEvent(new Event("change"));
      await wait(() =>
        expect(find(find(page.app, "dm-documents-page"), "lu-table")).not.toBeNull(),
      );
      await wait(() =>
        expect(text(find(find(page.app, "dm-documents-page"), "lu-table"))).toContain(
          SENTINEL.title,
        ),
      );
      await wait(() =>
        expect(text(find(find(page.app, "dm-documents-page"), "lu-table"))).toContain("Ready"),
      );
      expect(unnamedControls(page.app)).toEqual([]);

      // 4. Open the document from its row: its summary (loom-ui A2UI), analysis and tabs; ask a suggested question.
      labelled(
        find(page.app, "dm-documents-page"),
        "td.row-actions button",
        `Open: ${SENTINEL.title}`,
      )?.click();
      await wait(() => expect(route(page).name).toBe("document"));
      await wait(() => expect(text(page.app)).toContain("Payment is due in 30 days."));
      expect(deepAll(page.app, "[role=tab]").map((t) => t.textContent?.trim())).toEqual([
        "Summary",
        "Analysis",
        "Content",
      ]);
      expect(unnamedControls(page.app)).toEqual([]);
      const ask = deepAll(page.app, "button").find(
        (b) => b.textContent?.trim() === "When is payment due?",
      ) as HTMLButtonElement;
      ask.click();

      // 5. The chat opens scoped to the document, the question is sent for us, and the answer streams and ends cited.
      await wait(() => expect(route(page).name).toBe("chat"));
      const chatId = (route(page) as { chatId: string }).chatId;
      await wait(() => expect(find(page.app, "lu-chat button.ref")).not.toBeNull());
      expect(find(page.app, "lu-chat button.ref").textContent).toBe("1");
      expect(text(find(page.app, "lu-chat"))).toContain("When is payment due?");
      expect(text(find(page.app, "lu-chat"))).toContain("Searched documents");
      expect(text(find(page.app, "lu-chat"))).not.toContain("[[");
      // The sources panel is the `sources` experience: the card names the document, and the marker selects it.
      await wait(() => expect(text(find(page.app, "aside#sources"))).toContain(SENTINEL.title));
      find(page.app, "lu-chat button.ref").click();
      await wait(() =>
        expect(text(find(page.app, "aside#sources"))).toContain("Selected - Page 1"),
      );
      expect(unnamedControls(page.app)).toEqual([]);

      // 5b. Ask our own question in the composer (a loom-ui TextInput).
      const box = find(
        find(page.app, "dm-chat-page"),
        "lu-text-input textarea, lu-text-input input",
      );
      type(box, SENTINEL.question);
      submit(box.closest("form") as HTMLElement);
      await wait(() => expect(text(find(page.app, "lu-chat"))).toContain(SENTINEL.question));
      await wait(() =>
        expect(deepAll(page.app, "lu-chat button.ref").length).toBeGreaterThanOrEqual(2),
      );

      // 5c. The answer is markdown, drawn as elements by loom-ui: emphasis, a list and a safe link; raw HTML and an unsafe link stay inert.
      const answer = find(page.app, "lu-chat .md");
      expect(answer.querySelector("strong")?.textContent).toBe("30 days");
      expect(answer.querySelectorAll("ul > li")).toHaveLength(2);
      expect(answer.textContent).toContain("<b>Late</b> fees accrue monthly.");
      expect(answer.querySelector("b")).toBeNull();
      expect([...answer.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
        "https://example.com/terms",
      ]);
      expect(answer.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
      expect(answer.innerHTML).not.toContain("javascript:");
      expect(answer.textContent).not.toContain("**");

      // 6. "Open in document" goes to the passage in the Content tab.
      const open = deepAll(find(page.app, "aside#sources"), "button").find(
        (b) => b.textContent?.trim() === "Open in document",
      ) as HTMLButtonElement;
      open.click();
      await wait(() => expect(route(page).name).toBe("document"));
      expect((route(page) as { passage?: string }).passage).toBeTruthy();
      await wait(() =>
        expect(find(page.app, "[role=tab][aria-selected=true]")?.textContent?.trim()).toBe(
          "Content",
        ),
      );
      await wait(() => expect(text(page.app)).toContain("Cited passage"));
      expect(text(page.app)).toContain("Payment is due within 30 days of the invoice date.");

      // 7. Reload: a new page over the same server. The session is still there and the history comes back whole, citations included.
      page.app.remove();
      page = boot(server, `/chats/${chatId}`);
      await wait(() => expect(find(page.app, "lu-chat button.ref")).not.toBeNull());
      expect(server.calls.filter((c) => c === "GET /api/me").length).toBeGreaterThanOrEqual(2);
      expect(text(find(page.app, "lu-chat"))).toContain("Payment is due in 30 days.");
      expect(text(find(page.app, "lu-chat"))).toContain("Searched documents");
      expect(unnamedControls(page.app)).toEqual([]);

      // 7b. Rename the chat from the sidebar's own row action.
      await wait(() =>
        expect(labelled(page.app, "td.row-actions button", "Rename: New chat")).toBeDefined(),
      );
      labelled(page.app, "td.row-actions button", "Rename: New chat")?.click();
      await wait(() => expect(document.querySelector("dm-dialog input")).not.toBeNull());
      (document.querySelector("dm-dialog input") as HTMLInputElement).value = "Payment terms";
      (
        [...document.querySelectorAll("dm-dialog button")].find(
          (b) => b.textContent === "Save",
        ) as HTMLButtonElement
      ).click();
      await wait(() => expect(text(find(page.app, "dm-sessions"))).toContain("Payment terms"));

      // 8. Settings: delete the account with the password, read the receipt once, and check the state.
      follow(find(page.app, "a[href='/settings']"));
      await wait(() => expect(text(page.app)).toContain("Delete account"));
      expect(unnamedControls(page.app)).toEqual([]);
      find(page.app, "button[data-delete]").click();
      await wait(() => expect(deepFind(page.app, "input[type=password]")).not.toBeNull());
      type(find(page.app, "input[type=password]"), SENTINEL.password);
      await wait(() =>
        expect((find(page.app, "button[data-confirm]") as HTMLButtonElement).disabled).toBe(false),
      );
      find(page.app, "button[data-confirm]").click();
      await wait(() => expect(route(page)).toEqual({ name: "account-deleted" }));
      await wait(() => expect(find(page.app, "[data-receipt]").textContent).toBe(server.receipt));
      find(page.app, "button[data-check]").click();
      await wait(() => expect(text(page.app)).toContain("In progress"));
      find(page.app, "button[data-check]").click();
      await wait(() => expect(text(page.app)).toContain("Done."));
      page.app.remove();

      // 9. The data views were loom-ui's: the fake served the REAL compiled experiences, and every stamped action was fresh.
      expect(
        server.calls.filter((c) => c === "GET /api/ui/views/library").length,
      ).toBeGreaterThanOrEqual(1);
      expect(server.calls).toContain("POST /api/ui/hydrate");

      // 10. What the browser kept and said: nothing sensitive, anywhere.
      const secrets = [
        SENTINEL.email,
        SENTINEL.password,
        SENTINEL.file,
        SENTINEL.title,
        SENTINEL.question,
        server.receipt,
        "Payment is due",
      ];
      for (const line of logged)
        for (const secret of secrets)
          expect(line.includes(secret), "console line carried a secret").toBe(false);
      expect(Object.keys(localStorage).every((k) => k === "dm-theme")).toBe(true);
      expect(JSON.stringify(Object.entries(localStorage))).not.toMatch(
        new RegExp(secrets.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")),
      );
      expect(sessionStorage.length).toBe(0);
      for (const call of server.calls)
        for (const secret of [SENTINEL.email, SENTINEL.title, SENTINEL.question, SENTINEL.password])
          expect(call.includes(secret)).toBe(false);
    },
    SCENARIO_TIMEOUT,
  );
});
