/** What a visualize-turn run is about: ids only. `ord` is the assistant record's ordinal (`ChatMessageDto.id`). */
export interface TurnRef {
  tenantId: string;
  userId: string;
  chatId: string;
  ord: number;
}
