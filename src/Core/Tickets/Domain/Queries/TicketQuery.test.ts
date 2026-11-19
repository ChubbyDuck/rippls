import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { Ticket } from '../Entities/Ticket/entity';
import { Project } from '../Entities/Ticket/properties/Project';
import { formatTicketId } from '../Entities/Ticket/properties/TicketId';

import { matchesQuery } from './TicketQuery';

const id = (value: number) => formatTicketId('folder', String(value));
const billing = Schema.decodeSync(Project)('billing');
const web = Schema.decodeSync(Project)('web');

const ticket = (value: number, project?: Project) =>
  Ticket.create({ id: id(value), title: `Ticket ${value}`, project, body: '' });

describe('matchesQuery', () => {
  it('matches by id the ticket with that id, in any Project', () => {
    const query = { id: id(1) };

    expect(matchesQuery(query)(ticket(1, billing))).toBe(true);
    expect(matchesQuery(query)(ticket(1))).toBe(true);
    expect(matchesQuery(query)(ticket(2, billing))).toBe(false);
  });

  it('matches by project every ticket of that Project', () => {
    const query = { project: billing };

    expect(matchesQuery(query)(ticket(1, billing))).toBe(true);
    expect(matchesQuery(query)(ticket(2, billing))).toBe(true);
    expect(matchesQuery(query)(ticket(1, web))).toBe(false);
    expect(matchesQuery(query)(ticket(1))).toBe(false);
  });

  it('matches by both only the ticket with that id in that Project', () => {
    const query = { id: id(1), project: billing };

    expect(matchesQuery(query)(ticket(1, billing))).toBe(true);
    expect(matchesQuery(query)(ticket(1, web))).toBe(false);
    expect(matchesQuery(query)(ticket(2, billing))).toBe(false);
  });

  it('matches by neither every ticket', () => {
    expect(matchesQuery({})(ticket(1, billing))).toBe(true);
    expect(matchesQuery({})(ticket(2))).toBe(true);
  });
});
