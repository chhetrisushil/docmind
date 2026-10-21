import type { UiViewResponse, ViewName } from "@docmind/contracts";
import { type StampedAction, compileFingerprint, isStaleAction } from "@loom-ui/core/browser";
import {
  type HandleLoadRequest,
  type HandleLoadResult,
  type HandleLoader,
  HydrationStore,
  SplitHydrationController,
} from "@loom-ui/hydration/client";
import { createChatLitRegistry } from "@loom-ui/renderer-lit/chat";
import { referenceContainers } from "@loom-ui/renderer-lit/containers";
import { type DomRenderHandle, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import type { Api } from "../api/client";
import { report } from "../report";
import "./elements";

export interface ViewAction {
  type: string;
  widgetId: string;
  payload: Record<string, unknown>;
}
export type ActionAnswer = { ok: boolean; reason?: string } | undefined;
export type ActionHandler = (a: ViewAction) => Promise<ActionAnswer> | ActionAnswer;

/** Reads a chat transcript makes by moving: compared against the composition and compile fingerprint, not the binding sequence. */
const MOVING_READS = new Set(["LOAD_OLDER", "LOAD_REASONING", "EDIT_TURN", "CHAT_REF_OPEN"]);
const isLoadResult = (r: unknown): r is { finding?: { code?: string } } =>
  typeof r === "object" && r !== null;

/** Reloads one run of version-mismatch answers may cause before the view is given up as failed; a clean hydrate round restores it. */
const RELOAD_BUDGET = 2;

export class ViewSession {
  readonly store: HydrationStore;
  readonly split: SplitHydrationController;
  private readonly runtime = new InMemoryProjectionRuntime();
  private handle: DomRenderHandle | undefined;
  private reloading: Promise<void> | undefined;
  private disposed = false;
  private budget = RELOAD_BUDGET;
  private failed = false;
  private readonly abort = new AbortController();

  private constructor(
    private readonly api: Pick<Api, "uiView" | "uiHydrate">,
    readonly name: ViewName,
    private payload: UiViewResponse,
    private readonly onStale: (() => void) | undefined,
    private readonly onFailed: (() => void) | undefined,
  ) {
    this.store = new HydrationStore(this.runtime, { experienceId: payload.experienceId });
    const loader: HandleLoader = {
      load: async (request, signal) => (await loadMany([request], signal))[0] as HandleLoadResult,
      loadMany: (requests, signal) => loadMany(requests, signal),
    };
    const loadMany = async (
      requests: readonly HandleLoadRequest[],
      signal: AbortSignal,
    ): Promise<HandleLoadResult[]> => {
      const results = (await api.uiHydrate(name, [...requests], signal)) as HandleLoadResult[];
      if (results.some((r) => isLoadResult(r) && r.finding?.code === "version-mismatch")) {
        if (this.disposed) return results;
        if (this.budget > 0) {
          this.budget -= 1;
          void this.reload();
        } else if (!this.failed) {
          this.failed = true; // the server keeps disagreeing with the view it served: stop, and let the page say so
          this.onFailed?.();
        }
      } else {
        this.budget = RELOAD_BUDGET;
        this.failed = false;
      }
      return results;
    };
    this.split = new SplitHydrationController({ loader, store: this.store });
  }

  static async open(
    api: Pick<Api, "uiView" | "uiHydrate">,
    name: ViewName,
    o: { onStale?(): void; onFailed?(): void; signal?: AbortSignal } = {},
  ): Promise<ViewSession> {
    return new ViewSession(api, name, await api.uiView(name, o.signal), o.onStale, o.onFailed);
  }

  /** Applies the params to every handle, then loads the inventory (a handle loads with the params it declares, no others). */
  start(params?: Record<string, string | number>): void {
    if (params) this.split.setParams(params);
    this.split.load(this.payload.inventory as never);
  }

  mount(host: HTMLElement, onAction: ActionHandler): void {
    if (this.disposed || this.handle !== undefined) return;
    const fp = this.payload.fingerprint;
    this.handle = renderBlueprintDom(host, this.payload.blueprint as never, {
      projectionRuntime: this.runtime,
      executionId: this.store.executionId,
      registry: createChatLitRegistry(),
      containers: referenceContainers(),
      title: "none",
      compile: compileFingerprint({
        locale: "en",
        ...(fp.audience !== undefined && { audience: fp.audience }),
        restrictedHandles: fp.restrictedHandles,
        restrictedProjectionNodes: fp.restrictedProjectionNodes,
      }),
      onAction: (a: StampedAction) => this.dispatch(a, onAction),
    });
  }

  isFresh(action: { type: string; widgetId?: string; viewedVersion?: unknown }): boolean {
    if (this.handle === undefined) return false;
    const head = this.handle.head();
    const current = MOVING_READS.has(action.type)
      ? {
          experienceId: head.experienceId,
          versionHash: head.versionHash,
          ...(head.compile !== undefined && { compile: head.compile }),
        }
      : head;
    return !isStaleAction(action as never, current);
  }

  async dispatch(a: StampedAction, onAction: ActionHandler): Promise<ActionAnswer> {
    if (!this.isFresh(a)) {
      this.onStale?.();
      void this.reload();
      return { ok: false, reason: "stale" };
    }
    return (
      (await onAction({
        type: a.type,
        widgetId: a.widgetId,
        payload: (typeof a.payload === "object" && a.payload !== null ? a.payload : {}) as Record<
          string,
          unknown
        >,
      })) ?? { ok: true }
    );
  }

  setParams(params: Record<string, string | number>, handle?: string): void {
    this.split.setParams(params, handle === undefined ? undefined : { handle });
  }
  invalidate(handle?: string): void {
    if (handle === undefined)
      this.split.invalidate(); // one call, one batch
    else this.split.invalidate(handle);
  }

  publish(handle: string, value: unknown, kind: string, o: { streaming?: boolean } = {}): boolean {
    if (this.disposed) return false;
    return this.split.publishValue(handle, value, {
      state: o.streaming ? "pending" : "ready",
      kind,
    }).ok;
  }
  valueOf(handle: string): unknown {
    return (this.store.state().values as Record<string, unknown>)[handle];
  }
  statusOf(handle: string): string | undefined {
    return (this.store.state().status as Record<string, { state: string } | undefined>)[handle]
      ?.state;
  }

  /** Refetches the view and recomposes in place (a deploy changed it, or an action was stale). One reload at a time. */
  reload(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.reloading ??= (async () => {
      try {
        this.payload = await this.api.uiView(this.name, this.abort.signal);
        if (this.disposed) return;
        this.split.load(this.payload.inventory as never);
        this.invalidate(); // a handle whose revision did not change is not re-requested by load alone (a version-mismatch left it in error)
        this.handle?.update(this.payload.blueprint as never);
      } catch {
        // the next action or the page's "Try again" asks again
      } finally {
        this.reloading = undefined;
      }
    })();
    return this.reloading;
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    const handle = this.handle;
    this.handle = undefined;
    try {
      this.split.dispose(); // first: it aborts the hydrate fetches
    } finally {
      try {
        handle?.dispose();
      } catch (err) {
        report("view", err); // a widget that will not dispose must not keep the rest alive
      }
    }
  }
}
