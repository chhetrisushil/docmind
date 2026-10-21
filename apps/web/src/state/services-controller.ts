import { ContextConsumer } from "@lit/context";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { type Services, servicesContext } from "../services";

/**
 * Finds the services through the context and re-renders the host when any of the stores `pick` names changes. Use it as
 * `private readonly ctx = new ServicesController(this, (s) => [s.uploads])` and read `this.ctx.services` in `render`.
 */
export class ServicesController implements ReactiveController {
  services: Services | undefined;
  private offs: (() => void)[] = [];
  constructor(
    private readonly host: ReactiveControllerHost & HTMLElement,
    private readonly pick: (s: Services) => { subscribe(fn: () => void): () => void }[] = () => [],
  ) {
    host.addController(this);
    new ContextConsumer(host, {
      context: servicesContext,
      subscribe: true,
      callback: (svc) => this.bind(svc),
    });
  }
  private bind(svc: Services): void {
    this.unbind();
    this.services = svc;
    for (const store of this.pick(svc))
      this.offs.push(store.subscribe(() => this.host.requestUpdate()));
    this.host.requestUpdate();
  }
  private unbind(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
  hostDisconnected(): void {
    this.unbind();
  }
}
