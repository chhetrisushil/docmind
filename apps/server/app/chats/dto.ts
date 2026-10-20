import type { ChatSessionDto } from "@docmind/contracts";
import type { UserFieldCipher } from "../crypto/fields";
import { type ChatSessionRow, chatTitleBind } from "./sessions";

/** A chat row as the API shows it. The title is opened here; it is `null` until set (the UI says "New chat"). */
export async function toChatDto(
  row: ChatSessionRow,
  cipher: UserFieldCipher,
  activity: { messages: number; last_at: Date | null },
): Promise<ChatSessionDto> {
  return {
    id: row.id,
    title:
      row.title_enc === null ? null : await cipher.openText(chatTitleBind(row.id), row.title_enc),
    scope: row.scope,
    createdAt: row.created_at.toISOString(),
    lastMessageAt: activity.last_at === null ? null : activity.last_at.toISOString(),
    messageCount: activity.messages,
  };
}
