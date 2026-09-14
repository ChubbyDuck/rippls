import { Schema } from 'effect';

import { Project } from '../Entities/Ticket/properties/Project';
import { TicketId } from '../Entities/Ticket/properties/TicketId';

export const TicketQuerySortDirection = Schema.Literals(['ASC', 'DESC']);

export type TicketQuerySortDirection = typeof TicketQuerySortDirection.Type;

export const TicketQuerySchema = Schema.Struct({
  id: Schema.optionalKey(TicketId),
  blockedBy: Schema.optionalKey(TicketId),
  unblocked: Schema.optionalKey(Schema.Literal(true)),
  unclaimed: Schema.optionalKey(Schema.Literal(true)),
  claimed: Schema.optionalKey(Schema.Literal(true)),
  afk: Schema.optionalKey(Schema.Literal(true)),
  project: Schema.optionalKey(Project),
  sort: Schema.optionalKey(TicketQuerySortDirection),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

export type TicketQuery = typeof TicketQuerySchema.Type;

export interface TicketQueryChain {
  byId(id: TicketId): TicketQueryChain;
  blockedBy(id: TicketId): TicketQueryChain;
  unblocked(): TicketQueryChain;
  unclaimed(): TicketQueryChain;
  claimed(): TicketQueryChain;
  afk(): TicketQueryChain;
  byProject(project: Project): TicketQueryChain;
  sort(direction: TicketQuerySortDirection): TicketQueryChain;
  limit(n: number): TicketQueryChain;
  build(): TicketQuery;
}

type TicketQueryDraft = {
  id?: TicketId;
  blockedBy?: TicketId;
  unblocked?: true;
  unclaimed?: true;
  claimed?: true;
  afk?: true;
  project?: Project;
  sort?: TicketQuerySortDirection;
  limit?: number;
};

const chain = (draft: TicketQueryDraft): TicketQueryChain => ({
  byId: (id) => chain({ ...draft, id }),
  blockedBy: (id) => chain({ ...draft, blockedBy: id }),
  unblocked: () => chain({ ...draft, unblocked: true }),
  unclaimed: () => chain({ ...draft, unclaimed: true }),
  claimed: () => chain({ ...draft, claimed: true }),
  afk: () => chain({ ...draft, afk: true }),
  byProject: (project) => chain({ ...draft, project }),
  sort: (direction) => chain({ ...draft, sort: direction }),
  limit: (n) => chain({ ...draft, limit: n }),
  build: () => Object.freeze(Schema.decodeSync(TicketQuerySchema)(draft)),
});

export const TicketQuery: TicketQueryChain = chain({});
