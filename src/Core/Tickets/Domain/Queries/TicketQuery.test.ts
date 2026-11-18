import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { Project } from '../Entities/Ticket/properties/Project';
import { TicketId } from '../Entities/Ticket/properties/TicketId';

import { TicketQuery } from './TicketQuery';

const project = Schema.decodeSync(Project)('0003-sandboxed-local-ticket-loop.md');
const id = Schema.decodeSync(TicketId)('folder:1');

describe('TicketQuery', () => {
  it('builds a frozen object from the chosen chain', () => {
    const query = TicketQuery.byProject(project).byId(id).build();

    expect(query).toEqual({ project, id });
    expect(Object.isFrozen(query)).toBe(true);
  });

  it('omits clauses that were not chosen', () => {
    expect(TicketQuery.byProject(project).build()).toEqual({ project });
    expect(TicketQuery.build()).toEqual({});
  });

  it('does not mutate an earlier step when the chain continues', () => {
    const inProject = TicketQuery.byProject(project);

    expect(inProject.build()).toEqual({ project });
    expect(inProject.byId(id).build()).toEqual({ project, id });
    expect(inProject.build()).toEqual({ project });
  });
});
