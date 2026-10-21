import { ContextProvider } from "@lit/context";
import { type Services, servicesContext } from "../services";

/** Mounts `tag` under a services provider, as `dm-app` does, and waits for its first render. */
export async function mountWith<T extends HTMLElement>(
  services: Services,
  tag: string,
  props: Record<string, unknown> = {},
): Promise<T> {
  const host = document.createElement("div");
  new ContextProvider(host, { context: servicesContext, initialValue: services });
  const el = document.createElement(tag) as T;
  Object.assign(el, props);
  host.append(el);
  document.body.append(host);
  await (el as unknown as { updateComplete?: Promise<unknown> }).updateComplete;
  return el;
}
