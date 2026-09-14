import { Schema } from 'effect';

import type { Hitl } from './Hitl';

export const ImpliedHitlKind = Schema.Literals(['implementation', 'research', 'prototype', 'grilling']);

export type ImpliedHitlKind = typeof ImpliedHitlKind.Type;

export const TicketKind = Schema.Literals(['implementation', 'research', 'prototype', 'grilling', 'task']);

export type TicketKind = typeof TicketKind.Type;

export const impliedHitlByKind = {
  implementation: 'no',
  research: 'no',
  prototype: 'yes',
  grilling: 'yes',
} as const satisfies Record<ImpliedHitlKind, Hitl>;
