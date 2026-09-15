import { Effect, Option, Random } from 'effect';
import { expect, test } from 'vitest';

import { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import { TicketSourceLive } from './random';

const query = TicketQuery.build();

test('TicketSourceLive assigns a new id to each created ticket', () => {
  const ids = Effect.runSync(
    Effect.forEach(Array.from({ length: 100 }), () =>
      TicketSource.pipe(
        Effect.flatMap((source) => source.getOneBy(query)),
        Effect.option
      )
    ).pipe(
      Effect.map((tickets) =>
        tickets.flatMap((ticket) => (Option.isSome(ticket) ? [ticket.value.id] : []))
      ),
      Effect.provide(TicketSourceLive),
      Random.withSeed('ids')
    )
  );

  expect(ids).toEqual(ids.map((_, index) => `folder:${index + 1}`));
});

test('TicketSourceLive produces all ticket kinds equally', () => {
  const kinds = Effect.runSync(
    Effect.forEach(Array.from({ length: 1000 }), () =>
      TicketSource.pipe(
        Effect.flatMap((source) => source.getOneBy(query)),
        Effect.option
      )
    ).pipe(
      Effect.map((tickets) =>
        tickets.flatMap((ticket) => (Option.isSome(ticket) ? [ticket.value.kind] : []))
      ),
      Effect.provide(TicketSourceLive),
      Random.withSeed('kinds')
    )
  );

  const expected = kinds.length / TicketKind.literals.length;
  for (const kind of TicketKind.literals) {
    const count = kinds.filter((value) => value === kind).length;
    expect(count).toBeGreaterThan(expected * 0.5);
    expect(count).toBeLessThan(expected * 1.5);
  }
});
