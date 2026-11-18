import { Schema } from 'effect';

import { Project } from '../Entities/Ticket/properties/Project';
import { TicketId } from '../Entities/Ticket/properties/TicketId';

export const TicketQuerySchema = Schema.Struct({
  id: Schema.optionalKey(TicketId),
  project: Schema.optionalKey(Project),
});

export type TicketQuery = typeof TicketQuerySchema.Type;

export interface TicketQueryChain {
  byId(id: TicketId): TicketQueryChain;
  byProject(project: Project): TicketQueryChain;
  build(): TicketQuery;
}

type TicketQueryDraft = {
  id?: TicketId;
  project?: Project;
};

const chain = (draft: TicketQueryDraft): TicketQueryChain => ({
  byId: (id) => chain({ ...draft, id }),
  byProject: (project) => chain({ ...draft, project }),
  build: () => Object.freeze(Schema.decodeSync(TicketQuerySchema)(draft)),
});

export const TicketQuery: TicketQueryChain = chain({});
