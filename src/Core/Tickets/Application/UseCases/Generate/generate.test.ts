import { Effect, Layer } from 'effect';
import { expect, test } from 'vitest';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { TicketStatus } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketStatus';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';

import { generateTickets } from './generate';
import type { GenerateOptions } from './plan';

const defaults: GenerateOptions = { count: 36, kinds: [], statuses: [], hitls: [], projects: [], chain: false };

const runGenerate = (options: Partial<GenerateOptions>) => {
  const saved: Ticket[] = [];
  const repo = Layer.succeed(TicketRepository, {
    getOneBy: () => Effect.fail(new TicketNotFound()),
    getManyBy: () => Effect.succeed([]),
    save: (ticket) =>
      Effect.sync(() => {
        saved.push(ticket);
      }),
    saveMany: (tickets) =>
      Effect.sync(() => {
        saved.push(...tickets);
      }),
  });
  return Effect.runPromise(
    generateTickets({ ...defaults, ...options }).pipe(
      Effect.map((created) => ({ created, saved })),
      Effect.provide(repo)
    )
  );
};

test('generateTickets saves the requested amount with sequential ids', async () => {
  const { created, saved } = await runGenerate({ count: 20 });

  expect(created).toBe(20);
  expect(saved.length).toBe(20);
  expect(saved.map((ticket) => ticket.id)).toEqual(
    Array.from({ length: 20 }, (_unused, index) => `folder:${index + 1}`)
  );
  expect(saved[0]?.body).toBe('Reply with hello.');
  for (const ticket of saved) {
    expect(ticket.body.length).toBeGreaterThan(0);
  }
});

test('generateTickets spreads every kind, hitl and status by default', async () => {
  const { saved } = await runGenerate({ count: 36 });

  expect(new Set(saved.map((ticket) => ticket.kind))).toEqual(new Set(TicketKind.literals));
  expect(new Set(saved.map((ticket) => ticket.hitl))).toEqual(new Set(Hitl.literals));
  expect(new Set(saved.map((ticket) => ticket.status))).toEqual(new Set(TicketStatus.literals));
});

test('generateTickets honors the app rules when it derives hitl from kind', async () => {
  const { saved } = await runGenerate({ count: 12, kinds: ['prototype'] });

  expect(new Set(saved.map((ticket) => ticket.kind))).toEqual(new Set(['prototype']));
  expect(new Set(saved.map((ticket) => ticket.hitl))).toEqual(new Set(['yes']));
});

test('generateTickets limits attributes to the given subsets', async () => {
  const { saved } = await runGenerate({
    count: 10,
    kinds: ['task'],
    statuses: ['open'],
    hitls: ['no'],
    projects: ['alpha'],
  });

  for (const ticket of saved) {
    expect(ticket.kind).toBe('task');
    expect(ticket.status).toBe('open');
    expect(ticket.hitl).toBe('no');
    expect(ticket.project).toBe('alpha');
  }
});

test('generateTickets leaves tickets unlinked by default', async () => {
  const { saved } = await runGenerate({ count: 3 });

  for (const ticket of saved) {
    expect(ticket.blockedBy).toEqual([]);
    expect(ticket.blocks).toEqual([]);
  }
});

test('generateTickets chains each ticket to the next when chain is true', async () => {
  const { saved } = await runGenerate({ count: 4, chain: true });

  expect(
    saved.map((ticket) => ({
      id: ticket.id,
      blockedBy: [...ticket.blockedBy],
      blocks: [...ticket.blocks],
    }))
  ).toEqual([
    { id: 'folder:1', blockedBy: [], blocks: ['folder:2'] },
    { id: 'folder:2', blockedBy: ['folder:1'], blocks: ['folder:3'] },
    { id: 'folder:3', blockedBy: ['folder:2'], blocks: ['folder:4'] },
    { id: 'folder:4', blockedBy: ['folder:3'], blocks: [] },
  ]);
});

test('generateTickets fails when the kind and hitl constraints contradict', async () => {
  const error = await Effect.runPromise(
    generateTickets({ ...defaults, kinds: ['implementation'], hitls: ['yes'] }).pipe(
      Effect.flip,
      Effect.provide(
        Layer.succeed(TicketRepository, {
          getOneBy: () => Effect.fail(new TicketNotFound()),
          getManyBy: () => Effect.succeed([]),
          save: () => Effect.void,
          saveMany: () => Effect.void,
        })
      )
    )
  );

  expect(error._tag).toBe('NoTicketMatchesConstraints');
});
