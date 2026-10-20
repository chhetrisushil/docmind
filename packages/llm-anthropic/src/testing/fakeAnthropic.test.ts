import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeAnthropic, startFakeAnthropic } from "./fakeAnthropic";

describe("FakeAnthropic.holdNext", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake?.close();
  });
  const post = () =>
    fetch(`${fake.url}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: [] }] }),
    });

  it("parks the next request until released, and only that one", async () => {
    const gate = fake.holdNext();
    let answered = false;
    const parked = post().then((r) => {
      answered = true;
      return r.status;
    });
    await gate.reached;
    expect(answered).toBe(false);
    gate.release();
    await expect(parked).resolves.toBe(200);
    expect((await post()).status).toBe(200); // the next one is not held
  });
});
