import { Effect, Layer } from 'effect';
import { expect, test } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { completeTicket } from './completeTicket';

const id = (value: number) => formatTicketId('folder', String(value));

const blocked = (ticketId: number, blockedBy: number[]) =>
  Ticket.create({
    id: id(ticketId),
    title: 'Ticket',
    project: 'test',
    kind: 'implementation' as const,
    status: 'blocked' as const,
    blockedBy: blockedBy.map(id),
    blocks: [],
    body: '',
  });

const taken = (ticketId: number, blocks: number[]) =>
  Ticket.create({
    id: id(ticketId),
    title: 'Ticket',
    project: 'test',
    kind: 'implementation' as const,
    status: 'ready-for-agent' as const,
    blockedBy: [],
    blocks: blocks.map(id),
    body: '',
  });

const repoFrom = (seed: readonly Ticket[], saved: Ticket[]) => {
  const byId = new Map(seed.map((ticket) => [ticket.id, ticket]));
  return Layer.succeed(TicketSource, {
    getOneBy: (query) => {
      const found = query.id === undefined ? undefined : byId.get(query.id);
      return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
    },
    getManyBy: (query) =>
      Effect.succeed(
        query.blockedBy === undefined ? seed : seed.filter((ticket) => ticket.isBlockedBy(query.blockedBy!))
      ),
    save: (ticket) =>
      Effect.sync(() => {
        saved.push(ticket);
      }),
    saveMany: (tickets) =>
      Effect.sync(() => {
        saved.push(...tickets);
      }),
    report: () => Effect.void,
  });
};

test('completeTicket marks the ticket done and writes no other ticket', () => {
  const completed = taken(1, [2, 3]);
  const two = blocked(2, [1]);
  const three = blocked(3, [1, 4]);

  const saved: Ticket[] = [];
  const source = repoFrom([completed, two, three], saved);

  Effect.runSync(completeTicket({ ticketId: completed.id }).pipe(Effect.provide(source)));

  expect(saved).toEqual([completed.done()]);
});

test('completeTicket fails when the ticket id is not found', () => {
  const saved: Ticket[] = [];
  const source = repoFrom([], saved);

  const exit = Effect.runSyncExit(completeTicket({ ticketId: taken(1, []).id }).pipe(Effect.provide(source)));

  expect(exit._tag).toBe('Failure');
  expect(saved).toEqual([]);
});
