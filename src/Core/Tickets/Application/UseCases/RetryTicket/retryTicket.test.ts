import { Console, Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { TicketNotEscalated } from '~/Core/Tickets/Domain/Exceptions/TicketNotEscalated';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { makeLedgerMemory } from '~/Infrastructure/Tickets/Ledger/memory';

import { retryTicket } from './retryTicket';

const id = (value: number) => formatTicketId('folder', String(value));
const worktree = '/repo/.sandcastle/worktrees/ticket-folder-5';

type Reported = { readonly ticket: TicketId; readonly event: TicketEvent };

// A fake Source that only records the events reported to it. A report of the
// given event fails when `failing` names it.
const fakeSource = (failing?: TicketEvent) => {
  const reports: Reported[] = [];
  const layer = Layer.succeed(TicketSource, {
    getOneBy: () => Effect.die('getOneBy should not be called'),
    getManyBy: () => Effect.die('getManyBy should not be called'),
    save: () => Effect.die('save should not be called'),
    saveMany: () => Effect.die('saveMany should not be called'),
    report: (ticket, event) =>
      event === failing
        ? Effect.fail(new TicketEventNotReported({ ticketId: ticket, event }))
        : Effect.sync(() => {
            reports.push({ ticket, event });
          }),
  });
  return { layer, reports };
};

const escalated = (ticket: TicketId, attempts: number) =>
  new Escalation({ ticket, reason: 'strategy failure', attempts, worktree });

const setup = (escalations: readonly Escalation[], failing?: TicketEvent) => {
  const ledger = makeLedgerMemory();
  for (const escalation of escalations) {
    ledger.escalated.set(escalation.ticket, escalation);
  }
  const source = fakeSource(failing);
  return { ledger, source, layer: Layer.merge(ledger.layer, source.layer) };
};

const capturingConsole = (messages: string[]): Console.Console =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
  });

const retry = (ticket: TicketId, layer: Layer.Layer<Ledger | TicketSource>, messages: string[] = []) =>
  Effect.runPromise(
    retryTicket({ ticket }).pipe(
      Effect.result,
      Effect.provide(layer),
      Effect.provideService(Console.Console, capturingConsole(messages))
    )
  );

describe('retryTicket', () => {
  it('clears the Escalation, reports retried, and keeps the attempt count', async () => {
    const { ledger, source, layer } = setup([escalated(id(5), 2), escalated(id(6), 1)]);

    const outcome = await retry(id(5), layer);
    const escalatedAfterRetry = [...ledger.escalated.keys()];
    const next = await Effect.runPromise(
      Ledger.pipe(
        Effect.flatMap((held) => held.escalate(id(5), { reason: 'strategy failure', worktree })),
        Effect.provide(ledger.layer)
      )
    );

    expect(outcome._tag).toBe('Success');
    expect(source.reports).toEqual([{ ticket: id(5), event: 'retried' }]);
    expect(escalatedAfterRetry).toEqual([id(6)]);
    expect(next.attempts).toBe(3);
  });

  it('prints the attempt count and the Ticket Worktree the next run continues in', async () => {
    const messages: string[] = [];
    const { layer } = setup([escalated(id(5), 2)]);

    await retry(id(5), layer, messages);

    expect(messages).toEqual([
      `folder:5 is retried after 2 attempts; the next Engine run continues in its Ticket Worktree at ${worktree}`,
    ]);
  });

  it('fails with a clear message and changes nothing when the ticket is not escalated', async () => {
    const messages: string[] = [];
    const { ledger, source, layer } = setup([escalated(id(6), 1)]);

    const outcome = await retry(id(5), layer, messages);

    expect(outcome).toMatchObject({ _tag: 'Failure', failure: new TicketNotEscalated({ ticketId: id(5) }) });
    expect(new TicketNotEscalated({ ticketId: id(5) }).message).toBe(
      'folder:5 is not escalated, so there is nothing to retry'
    );
    expect(source.reports).toEqual([]);
    expect([...ledger.escalated.values()]).toEqual([escalated(id(6), 1)]);
    expect(ledger.cleared.size).toBe(0);
    expect(messages).toEqual([]);
  });

  it('keeps the Escalation when the Source cannot report retried', async () => {
    const { ledger, layer } = setup([escalated(id(5), 2)], 'retried');

    const outcome = await retry(id(5), layer);

    expect(outcome).toMatchObject({
      _tag: 'Failure',
      failure: new TicketEventNotReported({ ticketId: id(5), event: 'retried' }),
    });
    expect(ledger.escalated.get(id(5))).toEqual(escalated(id(5), 2));
  });
});
