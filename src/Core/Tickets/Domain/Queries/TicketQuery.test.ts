import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { Project } from '../Entities/Ticket/properties/Project';

import { TicketQuery } from './TicketQuery';

const project = Schema.decodeSync(Project)('0003-sandboxed-local-ticket-loop.md');

describe('TicketQuery', () => {
  it('builds a frozen object from the chosen chain', () => {
    const query = TicketQuery.byProject(project).sort('ASC').limit(1).build();

    expect(query).toEqual({ project, sort: 'ASC', limit: 1 });
    expect(Object.isFrozen(query)).toBe(true);
  });

  it('omits clauses that were not chosen', () => {
    expect(TicketQuery.byProject(project).build()).toEqual({ project });
    expect(TicketQuery.build()).toEqual({});
  });

  it('does not mutate an earlier step when the chain continues', () => {
    const inProject = TicketQuery.byProject(project);

    expect(inProject.build()).toEqual({ project });
    expect(inProject.sort('DESC').build()).toEqual({ project, sort: 'DESC' });
    expect(inProject.build()).toEqual({ project });
  });

  it('rejects a non-positive limit', () => {
    expect(() => TicketQuery.limit(0).build()).toThrow(Schema.SchemaError);
  });
});
