import type { DecideContext, PlannerModel } from "@loom-ui/planner";

/** A planner model that replies with `replies` in order, repeating the last, and counts its calls. */
export function scriptedPlannerModel(replies: string[]) {
  const model = {
    calls: 0,
    async complete() {
      const content = replies[Math.min(model.calls, replies.length - 1)] as string;
      model.calls += 1;
      return { content };
    },
  };
  return model satisfies PlannerModel;
}

/** A recording decide context: a repeated decision id is served from `decisions`, with no decider call. */
export function recording() {
  const decisions = new Map<string, unknown>();
  const ctx: DecideContext & { decisions: Map<string, unknown> } = {
    decisions,
    async decide(id, decider) {
      if (decisions.has(id)) return decisions.get(id) as never;
      const value = await decider({
        invokeTransient: () => Promise.reject(new Error("no scope in this stub")),
      });
      decisions.set(id, JSON.parse(JSON.stringify(value)));
      return value;
    },
  };
  return ctx;
}
