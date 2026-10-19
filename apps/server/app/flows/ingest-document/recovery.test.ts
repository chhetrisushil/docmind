import { describe, expect, it } from "vitest";
import { foldIngestStatus } from "../../status/model";
import { MAX_RECOVERIES, recoverIngest } from "./recovery";
import { boot, eventsOf, hanging, input, keptLog, start } from "./recoveryHarness";

describe("recoverIngest: giving executions up", () => {
  it("a crash loop is bounded: after MAX_RECOVERIES the document reads failed / internal and recovery stops", async () => {
    const log = keptLog();
    const ids = input();
    const first = hanging();
    await start(boot(log, first.deps), ids);
    await first.inStep;
    for (let boots = 0; boots < MAX_RECOVERIES; boots++) {
      const next = hanging();
      const app = boot(log, next.deps);
      void recoverIngest(app.runtime, log.kept, { graceMs: 0 }); // re-drives, then hangs again: a crash
      await next.inStep;
    }
    const last = boot(log, hanging().deps);
    expect(await recoverIngest(last.runtime, log.kept, { graceMs: 0 })).toMatchObject({
      recovered: 0,
      exhausted: 1,
    });
    const all = await eventsOf(log, ids);
    expect(all.filter((e) => e.eventType === "EXECUTION_RECOVERED")).toHaveLength(MAX_RECOVERIES);
    expect(foldIngestStatus(all)).toMatchObject({ status: "failed", code: "internal" });
    expect(all.at(-1)).toMatchObject({
      eventType: "EXECUTION_CANCELLED",
      payload: { reason: "ingest-recovery-exhausted" },
    });
    // terminal: another boot finds nothing to do
    expect(
      await recoverIngest(boot(log, hanging().deps).runtime, log.kept, { graceMs: 0 }),
    ).toMatchObject({
      scanned: 1,
      candidates: 0,
    });
  });
});
