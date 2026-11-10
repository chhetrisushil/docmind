import { MAX_TAGS_PER_FILTER, Uuid } from "@docmind/contracts";
import { Store } from "./state/store";

export type Route =
  | { name: "sign-in" }
  | { name: "sign-up" }
  | { name: "account-deleted" }
  | { name: "chat"; chatId?: string }
  | { name: "documents"; tags?: string[]; match?: "all" }
  | { name: "document"; id: string; passage?: string }
  | { name: "settings" }
  | { name: "not-found" };

const isUuid = (s: string) => Uuid.safeParse(s).success;

/** The library's `?tags=<id>,<id>&match=all`: valid ids only, lower-cased, deduplicated, at most 10; match is All or (omitted) Any. */
function libraryRoute(search: string): Route {
  const p = new URLSearchParams(search);
  const ids = [
    ...new Set(
      (p.get("tags") ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(isUuid),
    ),
  ].slice(0, MAX_TAGS_PER_FILTER);
  if (ids.length === 0) return { name: "documents" };
  return {
    name: "documents",
    tags: ids,
    ...(ids.length > 1 && p.get("match") === "all" && { match: "all" as const }),
  };
}

export function parseRoute(path: string, search = ""): Route {
  const p = path.replace(/\/+$/, "") || "/";
  switch (p) {
    case "/":
    case "/chats":
      return { name: "chat" };
    case "/documents":
      return libraryRoute(search);
    case "/sign-in":
      return { name: "sign-in" };
    case "/sign-up":
      return { name: "sign-up" };
    case "/account-deleted":
      return { name: "account-deleted" };
    case "/settings":
      return { name: "settings" };
  }
  const chat = /^\/chats\/([^/]+)$/.exec(p);
  if (chat && isUuid(chat[1] as string))
    return { name: "chat", chatId: (chat[1] as string).toLowerCase() };
  const doc = /^\/documents\/([^/]+)$/.exec(p);
  if (doc && isUuid(doc[1] as string)) {
    const passage = new URLSearchParams(search).get("passage");
    return {
      name: "document",
      id: (doc[1] as string).toLowerCase(),
      ...(passage !== null && isUuid(passage) && { passage: passage.toLowerCase() }),
    };
  }
  return { name: "not-found" };
}

export function hrefOf(r: Route): string {
  switch (r.name) {
    case "chat":
      return r.chatId ? `/chats/${r.chatId}` : "/chats";
    case "document":
      return `/documents/${r.id}${r.passage ? `?passage=${r.passage}` : ""}`;
    case "documents": {
      if (!r.tags || r.tags.length === 0) return "/documents";
      return `/documents?tags=${r.tags.join(",")}${r.tags.length > 1 && r.match === "all" ? "&match=all" : ""}`;
    }
    case "not-found":
      return "/chats";
    default:
      return `/${r.name}`;
  }
}

export type RouterWindow = Pick<
  Window,
  "location" | "history" | "addEventListener" | "removeEventListener"
>;

/** The current route, kept in sync with the address bar through the History API. */
export class Router extends Store<Route> {
  constructor(private readonly win: RouterWindow = window) {
    super(parseRoute(win.location.pathname, win.location.search));
  }
  get route(): Route {
    return this.get();
  }
  private readonly onPop = () =>
    this.set(parseRoute(this.win.location.pathname, this.win.location.search));
  start(): void {
    this.win.addEventListener("popstate", this.onPop);
  }
  stop(): void {
    this.win.removeEventListener("popstate", this.onPop);
  }
  navigate(r: Route, o: { replace?: boolean } = {}): void {
    const href = hrefOf(r);
    const here = this.win.location.pathname + this.win.location.search;
    if (href !== here)
      (o.replace ? this.win.history.replaceState : this.win.history.pushState).call(
        this.win.history,
        null,
        "",
        href,
      );
    this.set(r);
  }
}
