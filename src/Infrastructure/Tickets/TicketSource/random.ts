import { Effect, Layer, Random } from 'effect';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

const sampleTicket = (id: number, kind: TicketKind) =>
  Ticket.create({
    id: formatTicketId('folder', String(id)),
    title: 'Random ticket',
    project: '0003-sandboxed-local-ticket-loop.md',
    kind,
    ...(kind === 'task' ? { hitl: 'no' as const } : {}),
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
  });

export const TicketSourceLive = Layer.sync(TicketSource, () => {
  let created = 0;

  return {
    getOneBy: (_query) =>
      Random.nextIntBetween(0, 4).pipe(
        Effect.filterOrFail(
          (found) => found < 4,
          () => new TicketNotFound()
        ),
        Effect.andThen(Random.choice(TicketKind.literals)),
        Effect.map((kind) => sampleTicket(++created, kind))
      ),
    getManyBy: () => Effect.succeed([]),
    save: () => Effect.void,
    saveMany: () => Effect.void,
  };
});
