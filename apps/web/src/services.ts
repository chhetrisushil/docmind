import { createContext } from "@lit/context";
import { type Api, createApi } from "./api/client";
import { createHttp } from "./api/http";
import { type OpenSse, openSse } from "./api/sse";
import { Router } from "./router";
import { AuthStore } from "./state/auth";
import { ReceiptStore } from "./state/receipt";
import { ThemeStore } from "./state/theme";
import { ToastStore } from "./state/toasts";

export interface Services {
  api: Api;
  router: Router;
  auth: AuthStore;
  theme: ThemeStore;
  toasts: ToastStore;
  receipt: ReceiptStore;
  open: OpenSse;
}

export const servicesContext = createContext<Services>(Symbol.for("dm-services"));

export interface ServiceOverrides extends Partial<Services> {
  fetch?: typeof fetch;
  xhr?: () => XMLHttpRequest;
}

/** The one composition root of the UI: everything else receives its collaborators from here. */
export function createServices(o: ServiceOverrides = {}): Services {
  // A 401 'unauthorized' from any call ends the session; the route guard in dm-app does the redirect.
  const late: { auth?: AuthStore } = {};
  const onUnauthorized = (epoch: number | undefined) => late.auth?.expired(epoch);
  const epoch = () => late.auth?.epoch ?? 0;
  const http = createHttp({ ...(o.fetch && { fetch: o.fetch }), epoch, onUnauthorized });
  const api = o.api ?? createApi(http, { ...(o.xhr && { xhr: o.xhr }), epoch, onUnauthorized });
  const auth = o.auth ?? new AuthStore(api);
  late.auth = auth;
  return {
    api,
    auth,
    router: o.router ?? new Router(),
    theme: o.theme ?? new ThemeStore(),
    toasts: o.toasts ?? new ToastStore(),
    receipt: o.receipt ?? new ReceiptStore(),
    open: o.open ?? ((opts) => openSse({ ...(o.fetch && { fetch: o.fetch }), ...opts })),
  };
}
