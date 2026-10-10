export interface MessageEntity {
  type: 'bold' | 'italic' | 'code' | 'text_link';
  offset: number;
  length: number;
  url?: string;
}

export interface FormattedMessage {
  text: string;
  entities: MessageEntity[];
}

export function sliceEntities(
  entities: MessageEntity[],
  offset: number,
  length: number,
) {
  const end = offset + length;
  return entities.flatMap((entity) => {
    const start = Math.max(entity.offset, offset);
    const stop = Math.min(entity.offset + entity.length, end);
    return stop > start
      ? [{ ...entity, offset: start - offset, length: stop - start }]
      : [];
  });
}
