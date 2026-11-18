import { Schema } from 'effect';

import { fallbackHitl, Hitl } from './properties/Hitl';
import { hitlByMarker, Marker } from './properties/Marker';
import { Project } from './properties/Project';
import { TicketId } from './properties/TicketId';
import { defaultTicketKind, hitlImpliedBy, TicketKind } from './properties/TicketKind';
import { Title } from './properties/Title';

export class Ticket extends Schema.Class<Ticket>('Ticket')({
  id: TicketId,
  title: Title,
  project: Schema.optional(Project),
  kind: TicketKind,
  hitl: Hitl,
  blockedBy: Schema.Array(TicketId),
  body: Schema.String,
  /** Whether its Source sees the ticket as done: in `done/`, or completed on Linear. */
  doneInSource: Schema.Boolean,
}) {
  /** A Ticket from what a Source read, with the standard fallbacks unless others are given. */
  static create(hints: unknown, fallbacks: TicketFallbacks = standardFallbacks): Ticket {
    return ticketFromHints(Schema.decodeUnknownSync(TicketHints)(hints), fallbacks);
  }

  get label(): string {
    return `Ticket ${this.id} -- ${this.kind}`;
  }

  isBlockedBy(id: TicketId): boolean {
    return this.blockedBy.includes(id);
  }
}

/**
 * What a Source read from a ticket. A Ticket needs only its identity, Title, and
 * body; everything else is a hint with a fallback. A Source derives the Title from
 * what it has, so it is always present.
 */
export const TicketHints = Schema.Struct({
  id: TicketId,
  title: Title,
  body: Schema.String,
  project: Schema.optional(Project),
  blockedBy: Schema.optional(Schema.Array(TicketId)),
  kind: Schema.optional(TicketKind),
  hitl: Schema.optional(Hitl),
  marker: Schema.optional(Marker),
  doneInSource: Schema.optional(Schema.Boolean),
});

export type TicketHints = typeof TicketHints.Type;

/**
 * What a Ticket gets for a hint it does not state: the default Ticket Kind from
 * config, and the HITL fallback.
 */
export type TicketFallbacks = {
  readonly kind: TicketKind;
  readonly hitl: Hitl;
};

/** The default Ticket Kind is `implementation`; a ticket that does not say it is ready is HITL yes. */
export const standardFallbacks: TicketFallbacks = { kind: defaultTicketKind, hitl: fallbackHitl };

/**
 * The HITL of a ticket: the first of a stated HITL, the HITL its Marker implies, and
 * the HITL its stated Ticket Kind implies; otherwise the fallback. A Ticket Kind that
 * comes from the fallback implies nothing.
 */
export const hitlFromHints = (hints: TicketHints, fallback: Hitl): Hitl =>
  hints.hitl ??
  (hints.marker === undefined ? undefined : hitlByMarker[hints.marker]) ??
  (hints.kind === undefined ? undefined : hitlImpliedBy(hints.kind)) ??
  fallback;

export const ticketFromHints = (hints: TicketHints, fallbacks: TicketFallbacks): Ticket =>
  new Ticket({
    id: hints.id,
    title: hints.title,
    project: hints.project,
    kind: hints.kind ?? fallbacks.kind,
    hitl: hitlFromHints(hints, fallbacks.hitl),
    blockedBy: hints.blockedBy ?? [],
    body: hints.body,
    doneInSource: hints.doneInSource ?? false,
  });
