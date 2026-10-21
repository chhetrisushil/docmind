/** A first message waiting for its chat page (a suggested question leaves it, the new chat page sends it once). */
export type Outbox = { chatId: string; text: string } | undefined;
