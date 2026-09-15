import { Effect, Layer, Schema } from 'effect';
import { expect, test } from 'vitest';

import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { completeTicket } from './completeTicket';

const runner = Schema.decodeSync(RunnerId)('runner');
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

const claimed = (ticketId: number, blocks: number[]) =>
  Ticket.create({
    id: id(ticketId),
    title: 'Ticket',
    project: 'test',
    kind: 'implementation' as const,
    status: 'ready-for-agent' as const,
    blockedBy: [],
    blocks: blocks.map(id),
    body: '',
  }).claim({ by: runner });

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
  });
};

test('completeTicket marks the ticket done and unblocks only its dependents', () => {
  const completed = claimed(1, [2, 3]);
  const two = blocked(2, [1]);
  const three = blocked(3, [1, 4]);
  const five = blocked(5, [4]);

  const saved: Ticket[] = [];
  const source = repoFrom([completed, two, three, five], saved);

  Effect.runSync(completeTicket({ ticketId: completed.id }).pipe(Effect.provide(source)));

  expect(saved.map((ticket) => [ticket.id, ticket.status])).toEqual([
    [id(1), 'done'],
    [id(2), 'ready-for-agent'],
    [id(3), 'blocked'],
  ]);
  expect(saved[2]?.blockedBy).toEqual([id(4)]);
});

test('completeTicket saves only the done ticket when nothing is blocked by it', () => {
  const completed = claimed(1, []);

  const saved: Ticket[] = [];
  const source = repoFrom([completed], saved);

  Effect.runSync(completeTicket({ ticketId: completed.id }).pipe(Effect.provide(source)));

  expect(saved.map((ticket) => [ticket.id, ticket.status])).toEqual([[id(1), 'done']]);
});

test('completeTicket fails when the ticket id is not found', () => {
  const saved: Ticket[] = [];
  const source = repoFrom([], saved);

  const exit = Effect.runSyncExit(completeTicket({ ticketId: claimed(1, []).id }).pipe(Effect.provide(source)));

  expect(exit._tag).toBe('Failure');
  expect(saved).toEqual([]);
});
