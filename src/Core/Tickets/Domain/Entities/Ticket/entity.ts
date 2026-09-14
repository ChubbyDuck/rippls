import { Schema, SchemaGetter } from 'effect';

import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';

import { Hitl } from './properties/Hitl';
import { Project } from './properties/Project';
import { TicketId } from './properties/TicketId';
import { impliedHitlByKind, ImpliedHitlKind, TicketKind } from './properties/TicketKind';
import { TicketStatus } from './properties/TicketStatus';
import { Title } from './properties/Title';

const ticketBase = {
  id: TicketId,
  title: Title,
  project: Schema.optional(Project),
  status: TicketStatus,
  blockedBy: Schema.Array(TicketId),
  blocks: Schema.Array(TicketId),
  claimedBy: Schema.optionalKey(RunnerId),
  body: Schema.String,
};

const ImpliedHitlTicket = Schema.Struct({
  ...ticketBase,
  kind: ImpliedHitlKind,
}).pipe(
  Schema.decodeTo(Schema.Struct({ ...ticketBase, kind: ImpliedHitlKind, hitl: Hitl }), {
    decode: SchemaGetter.transform((input) => ({
      ...input,
      hitl: impliedHitlByKind[input.kind],
    })),
    encode: SchemaGetter.passthrough({ strict: false }),
  })
);

const TaskTicket = Schema.Struct({
  ...ticketBase,
  kind: Schema.Literal('task'),
  hitl: Hitl,
});

export const TicketInput = Schema.Union([ImpliedHitlTicket, TaskTicket]);

export class Ticket extends Schema.Class<Ticket>('Ticket')({
  ...ticketBase,
  kind: TicketKind,
  hitl: Hitl,
}) {
  static create(fields: unknown): Ticket {
    return Schema.decodeUnknownSync(TicketFromInput)(fields);
  }

  get label(): string {
    return `Ticket ${this.id} -- ${this.kind}`;
  }

  claim({ by }: { by: RunnerId }): Ticket {
    return new Ticket({
      id: this.id,
      title: this.title,
      project: this.project,
      status: 'claimed',
      blockedBy: this.blockedBy,
      blocks: this.blocks,
      claimedBy: by,
      kind: this.kind,
      hitl: this.hitl,
      body: this.body,
    });
  }

  markClaiming(): Ticket {
    return new Ticket({
      id: this.id,
      title: this.title,
      project: this.project,
      status: 'claiming',
      blockedBy: this.blockedBy,
      blocks: this.blocks,
      kind: this.kind,
      hitl: this.hitl,
      body: this.body,
    });
  }

  release(): Ticket {
    return new Ticket({
      id: this.id,
      title: this.title,
      project: this.project,
      status: 'ready-for-agent',
      blockedBy: this.blockedBy,
      blocks: this.blocks,
      kind: this.kind,
      hitl: this.hitl,
      body: this.body,
    });
  }

  done(): Ticket {
    return new Ticket({
      id: this.id,
      title: this.title,
      project: this.project,
      status: 'done',
      blockedBy: this.blockedBy,
      blocks: this.blocks,
      claimedBy: this.claimedBy,
      kind: this.kind,
      hitl: this.hitl,
      body: this.body,
    });
  }

  escalate(): Ticket {
    return new Ticket({
      id: this.id,
      title: this.title,
      project: this.project,
      status: 'ready-for-agent',
      blockedBy: this.blockedBy,
      blocks: this.blocks,
      kind: 'task',
      hitl: 'yes',
      body: this.body,
    });
  }

  isBlockedBy(id: TicketId): boolean {
    return this.blockedBy.includes(id);
  }

  unblockedBy(id: TicketId): Ticket {
    const blockedBy = this.blockedBy.filter((other) => other !== id);
    return new Ticket({
      id: this.id,
      title: this.title,
      project: this.project,
      status: blockedBy.length === 0 ? 'ready-for-agent' : this.status,
      blockedBy,
      blocks: this.blocks,
      kind: this.kind,
      hitl: this.hitl,
      body: this.body,
    });
  }
}

export const TicketFromInput = TicketInput.pipe(Schema.decodeTo(Ticket));
