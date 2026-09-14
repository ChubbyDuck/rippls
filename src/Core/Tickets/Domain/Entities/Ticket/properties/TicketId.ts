import { Schema } from 'effect';

export const TicketId = Schema.String.check(Schema.isPattern(/^[^:]+:.+$/)).pipe(Schema.brand('TicketId'));

export type TicketId = typeof TicketId.Type;

export const formatTicketId = (source: string, native: string): TicketId =>
  Schema.decodeSync(TicketId)(`${source}:${native}`);

export const parseTicketId = (id: TicketId): { readonly source: string; readonly native: string } => {
  const separator = id.indexOf(':');
  return { source: id.slice(0, separator), native: id.slice(separator + 1) };
};
