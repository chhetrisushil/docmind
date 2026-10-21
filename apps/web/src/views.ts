import type { Route } from "./router";

/** Route name to the element that draws it. Each view's task adds its own entry; a route without one draws `dm-not-found`. */
export const VIEWS: Partial<Record<Route["name"], string>> = {};
