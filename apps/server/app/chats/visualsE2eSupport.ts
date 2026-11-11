import { randomUUID } from "node:crypto";
import type { UploadDocumentResponse } from "@docmind/contracts";
import type { FakeAnthropic } from "@docmind/llm-anthropic/testing";
import { expect } from "vitest";
import type { IngestStack } from "../documents/ingestStack";
import { DOC, collectUntil, isReply } from "./e2eSupport";

export const LABEL = "Zebra-Quarterly-Takings";
export const FIGURE_DOC = `${DOC} ${LABEL} reached 7391.25 in the last quarter.`;
const CHUNK_ID = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/;

/** A `visuals` model that finds the figure in whatever it is shown while `state.extract` is on, and plans a KeyFigure bound to the first offered fact. */
export function stubVisuals(claude: FakeAnthropic, state: { extract: boolean; calls: number }) {
  claude.reply((body) => {
    state.calls++;
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    const text = JSON.stringify(body.messages);
    if (system.includes("You extract facts")) {
      const chunk = CHUNK_ID.exec(text)?.[1];
      if (!state.extract || !chunk || !text.includes(LABEL)) return { text: '{"facts":[]}' };
      return {
        text: JSON.stringify({
          facts: [{ kind: "figure", label: LABEL, value: 7391.25, unit: "USD", chunkIds: [chunk] }],
        }),
      };
    }
    return {
      text: JSON.stringify({
        summary: "A headline figure",
        nodes: [
          {
            id: "headline",
            type: "KeyFigure",
            label: LABEL,
            span: 4,
            props: {},
            binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
          },
        ],
      }),
    };
  });
}

/** Uploads the figure document and waits until it is ready; the passage id the chat model will cite. */
export async function readyDocument(st: IngestStack, cookie: string) {
  const events = await st.events(cookie);
  try {
    const up = await st.upload(cookie, "report.txt", Buffer.from(FIGURE_DOC));
    expect(up.status).toBe(201);
    const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
    await st.until(events, documentId, (s) => s === "ready" || s === "failed");
    const chunks = await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [
      documentId,
    ]);
    return { documentId, passageId: chunks.rows[0].id as string };
  } finally {
    events.close();
  }
}

/** Asks one question; resolves with the reply frame's data. */
export async function askChat(st: IngestStack, cookie: string, chatId: string, text: string) {
  const stream = await st.openChat(cookie, chatId);
  try {
    const sent = await st.chatReq(cookie, "POST", `/api/chats/${chatId}/messages`, {
      text,
      messageId: randomUUID(),
    });
    expect(sent.status).toBe(202);
    const frames = await collectUntil(stream, isReply);
    return frames.find(isReply)?.data as { id: string; hasVisuals?: boolean; citations: unknown[] };
  } finally {
    stream.close();
  }
}
