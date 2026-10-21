import { createContext } from "@lit/context";
import { type Api, createApi } from "./api/client";
import { createHttp } from "./api/http";
import { type OpenSse, openSse } from "./api/sse";
import { Router } from "./router";
import { ThemeStore } from "./state/theme";
import { ToastStore } from "./state/toasts";

export interface Services {
  api: Api;
  router: Router;
  theme: ThemeStore;
  toasts: ToastStore;
  open: OpenSse;
}

export const servicesContext = createContext<Services>(Symbol.for("dm-services"));

/** What a 401 'unauthorized' does. Task 183 replaces it with `auth.expired()`. */
export const hooks = { unauthorized: (): void => {} };

export interface ServiceOverrides extends Partial<Services> {
  fetch?: typeof fetch;
  xhr?: () => XMLHttpRequest;
}

/** The one composition root of the UI: everything else receives its collaborators from here. */
export function createServices(o: ServiceOverrides = {}): Services {
  const onUnauthorized = () => hooks.unauthorized();
  const http = createHttp({ ...(o.fetch && { fetch: o.fetch }), onUnauthorized });
  const api = o.api ?? createApi(http, { ...(o.xhr && { xhr: o.xhr }), onUnauthorized });
  return {
    api,
    router: o.router ?? new Router(),
    theme: o.theme ?? new ThemeStore(),
    toasts: o.toasts ?? new ToastStore(),
    open: o.open ?? ((opts) => openSse({ ...(o.fetch && { fetch: o.fetch }), ...opts })),
  };
}
