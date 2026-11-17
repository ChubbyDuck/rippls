import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { Project } from '../Entities/Ticket/properties/Project';

import { TicketQuery } from './TicketQuery';

const project = Schema.decodeSync(Project)('0003-sandboxed-local-ticket-loop.md');

describe('TicketQuery', () => {
  it('builds a frozen object from the chosen chain', () => {
    const query = TicketQuery.claimed().byProject(project).sort('ASC').limit(1).build();

    expect(query).toEqual({ claimed: true, project, sort: 'ASC', limit: 1 });
    expect(Object.isFrozen(query)).toBe(true);
  });

  it('omits clauses that were not chosen', () => {
    expect(TicketQuery.byProject(project).build()).toEqual({ project });
    expect(TicketQuery.build()).toEqual({});
  });

  it('does not mutate an earlier step when the chain continues', () => {
    const inProject = TicketQuery.byProject(project);

    expect(inProject.build()).toEqual({ project });
    expect(inProject.claimed().build()).toEqual({ project, claimed: true });
    expect(inProject.build()).toEqual({ project });
  });

  it('selects claimed and claiming tickets when claimed is chosen', () => {
    expect(TicketQuery.claimed().byProject(project).build()).toEqual({ claimed: true, project });
  });

  it('rejects a non-positive limit', () => {
    expect(() => TicketQuery.limit(0).build()).toThrow(Schema.SchemaError);
  });
});
