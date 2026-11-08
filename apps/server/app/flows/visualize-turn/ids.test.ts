import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isVisualizeExecution } from "../../status/model";
import { executionIdFor } from "../../subject";
import {
  isTurnVisualizeExecution,
  parseTurnExecution,
  turnExecutionId,
  turnExperienceId,
} from "./ids";

const user = randomUUID();
const chat = randomUUID();

describe("turn ids", () => {
  it("builds the automatic and the on-demand execution id under the user's prefix", () => {
    expect(turnExecutionId(user, chat, 6)).toBe(executionIdFor(user, `visualize-turn-${chat}-6`));
    expect(turnExecutionId(user, chat, 6, 2)).toBe(`u_${user}:visualize-turn-${chat}-6-r2`);
  });
  it("builds the lineage id", () => {
    expect(turnExperienceId({ userId: user, chatId: chat, ord: 6 })).toBe(
      `turnvisuals-${user}-${chat}-6`,
    );
  });
  it("refuses a bad ord or re-run number", () => {
    for (const bad of [0, -1, 1.5, 1_000_000_000_000_000])
      expect(() => turnExecutionId(user, chat, bad)).toThrow(RangeError);
    expect(() => turnExecutionId(user, chat, 999_999_999_999_999)).not.toThrow(); // RecordOrd's top: the range of ChatMessageDto.id
    for (const bad of [0, 1.5, 1_000])
      expect(() => turnExecutionId(user, chat, 6, bad)).toThrow(RangeError);
  });
  it("parses what it builds and nothing else, and is never a document-visualize or ingest id", () => {
    const id = turnExecutionId(user, chat, 6, 3);
    expect(parseTurnExecution(id)).toEqual({ userId: user, chatId: chat, ord: 6, rerun: 3 });
    expect(parseTurnExecution(turnExecutionId(user, chat, 6))).toEqual({
      userId: user,
      chatId: chat,
      ord: 6,
    });
    expect(parseTurnExecution(`u_${user}:visualize-${chat}`)).toBeNull();
    expect(parseTurnExecution(`u_${user}:visualize-turn-${chat}-06`)).toBeNull();
    expect(isTurnVisualizeExecution(id)).toBe(true);
    expect(isVisualizeExecution(id)).toBe(false);
  });
});
