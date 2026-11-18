import { Schema } from 'effect';

export const TicketStatus = Schema.Literals([
  'open',
  'ready-for-agent',
  'done',
  'resolved',
  'blocked',
]);

export type TicketStatus = typeof TicketStatus.Type;
