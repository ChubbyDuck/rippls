import { Schema } from 'effect';

export const TicketStatus = Schema.Literals([
  'open',
  'ready-for-agent',
  'claiming',
  'claimed',
  'done',
  'resolved',
  'blocked',
]);

export type TicketStatus = typeof TicketStatus.Type;
