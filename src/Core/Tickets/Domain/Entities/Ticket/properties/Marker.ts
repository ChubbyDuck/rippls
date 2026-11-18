import { Schema } from 'effect';

import type { Hitl } from './Hitl';

/**
 * A readiness marker a ticket may state, from the triage vocabulary of ticket-writing
 * skills. It is read only for the HITL it implies.
 */
export const Marker = Schema.Literals(['ready-for-agent', 'ready-for-human']);

export type Marker = typeof Marker.Type;

export const hitlByMarker = {
  'ready-for-agent': 'no',
  'ready-for-human': 'yes',
} as const satisfies Record<Marker, Hitl>;
