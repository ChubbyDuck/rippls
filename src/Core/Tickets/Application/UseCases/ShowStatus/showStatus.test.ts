import { Console, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { makeLedgerMemory } from '~/Infrastructure/Tickets/Ledger/memory';

import type { ShowStatusCommand } from './command';
import { showStatus, ticketStatuses } from './showStatus';

const id = (value: number) => formatTicketId('folder', String(value));
const billing = Schema.decodeSync(Project)('billing');
const web = Schema.decodeSync(Project)('web');
const engine = Schema.decodeSync(EngineId)('engine-1234');
const runner = Schema.decodeSync(RunnerId)('engine-1234:runner-a');

const ticket = (value: number, fields: Record<string, unknown> = {}) =>
  Ticket.create({
    id: id(value),
    title: `Ticket ${value}`,
    project: billing,
    kind: 'task',
    hitl: 'no',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
    ...fields,
  });

// A fake Source that keeps tickets in memory, in the order given. A read for the
// tickets in scope returns every one of them, narrowed only by Project.
const fakeSource = (tickets: readonly Ticket[]) => {
  const read = (query: TicketQuery) =>
    tickets.filter(
      (candidate) =>
        (query.id === undefined || candidate.id === query.id) &&
        (query.blockedBy === undefined || candidate.isBlockedBy(query.blockedBy)) &&
        (query.project === undefined || candidate.project === query.project)
    );
  return Layer.succeed(TicketSource, {
    getOneBy: (query) =>
      Effect.suspend(() => {
        const [found] = read(query);
        return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
      }),
    getManyBy: (query) => Effect.sync(() => read(query)),
    save: () => Effect.void,
    saveMany: () => Effect.void,
    report: () => Effect.void,
  });
};

// The Ledger runs process 1 on the host `memory`; a Claim of another process on
// that host is a Stale Claim.
const claimOf = (ticket: TicketId, process = 1) =>
  new Claim({ ticket, engine, process, host: 'memory', runner });

const escalationOf = (ticket: TicketId) =>
  new Escalation({ ticket, reason: 'strategy failure', attempts: 2, worktree: '/repo/.sandcastle/worktrees/ticket-5' });

const setup = (
  tickets: readonly Ticket[],
  { claims = [], escalations = [] }: { readonly claims?: readonly Claim[]; readonly escalations?: readonly Escalation[] } = {}
) => {
  const ledger = makeLedgerMemory();
  for (const claim of claims) {
    ledger.claims.set(claim.ticket, claim);
  }
  for (const escalation of escalations) {
    ledger.escalated.set(escalation.ticket, escalation);
  }
  return Layer.merge(fakeSource(tickets), ledger.layer);
};

const statusesOf = (layer: ReturnType<typeof setup>, command: ShowStatusCommand = {}) =>
  Effect.runPromise(
    ticketStatuses(command).pipe(
      Effect.map((lines) => lines.map((line) => [line.ticket.id, line.status] as const)),
      Effect.provide(layer)
    )
  );

const capturingConsole = (messages: string[]): Console.Console =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<unknown>) => {
      messages.push(args.map(String).join(' '));
    },
  });

const printed = async (layer: ReturnType<typeof setup>, command: ShowStatusCommand = {}) => {
  const messages: string[] = [];
  await Effect.runPromise(
    showStatus(command).pipe(Effect.provide(layer), Effect.provideService(Console.Console, capturingConsole(messages)))
  );
  return messages;
};

describe('ticketStatuses', () => {
  it('derives one Ticket Status for every ticket in scope, one ticket for each value', async () => {
    const layer = setup(
      [
        ticket(1).done(),
        ticket(2),
        ticket(3),
        ticket(4, { hitl: 'yes' }),
        ticket(5, { blockedBy: [id(9)] }),
        ticket(6, { blockedBy: [id(1)] }),
      ],
      { claims: [claimOf(id(3))], escalations: [escalationOf(id(2))] }
    );

    expect(await statusesOf(layer)).toEqual([
      [id(1), 'done'],
      [id(2), 'escalated'],
      [id(3), 'claimed'],
      [id(4), 'not ready'],
      [id(5), 'blocked'],
      [id(6), 'eligible'],
    ]);
  });

  it('shows the first of done, escalated, claimed, not ready, and blocked when several apply', async () => {
    const several = { hitl: 'yes', blockedBy: [id(9)] };
    const layer = setup(
      [ticket(1, several).done(), ticket(2, several), ticket(3, several), ticket(4, several)],
      {
        claims: [claimOf(id(1)), claimOf(id(2)), claimOf(id(3))],
        escalations: [escalationOf(id(1)), escalationOf(id(2))],
      }
    );

    expect(await statusesOf(layer)).toEqual([
      [id(1), 'done'],
      [id(2), 'escalated'],
      [id(3), 'claimed'],
      [id(4), 'not ready'],
    ]);
  });

  it('counts a ticket whose only Claim is a Stale Claim as unclaimed', async () => {
    const layer = setup([ticket(1)], { claims: [claimOf(id(1), 4242)] });

    expect(await statusesOf(layer)).toEqual([[id(1), 'eligible']]);
  });

  it('lists only the tickets of the Project when a Project is given', async () => {
    const layer = setup([ticket(1), ticket(2, { project: web }), ticket(3)]);

    expect(await statusesOf(layer, { project: billing })).toEqual([
      [id(1), 'eligible'],
      [id(3), 'eligible'],
    ]);
  });

  it('resolves a blocker of another Project when a Project is given', async () => {
    const layer = setup([ticket(1, { project: web }).done(), ticket(2, { blockedBy: [id(1)] })]);

    expect(await statusesOf(layer, { project: billing })).toEqual([[id(2), 'eligible']]);
  });
});

describe('showStatus', () => {
  it('prints the identity, the Ticket Status, and the Title of every ticket', async () => {
    const layer = setup([ticket(1).done(), ticket(2)]);

    expect(await printed(layer)).toEqual(['folder:1  done       Ticket 1', 'folder:2  eligible   Ticket 2']);
  });

  it('prints the Engine, the Runner, the process, and the host of the Claim of a claimed ticket', async () => {
    const layer = setup([ticket(3)], { claims: [claimOf(id(3))] });

    expect(await printed(layer)).toEqual([
      'folder:3  claimed    Ticket 3 (Claim: Engine engine-1234, Runner engine-1234:runner-a, process 1, host memory)',
    ]);
  });

  it('prints a Claim that has no Runner yet', async () => {
    const claim = new Claim({ ticket: id(3), engine, process: 1, host: 'memory' });
    const layer = setup([ticket(3)], { claims: [claim] });

    expect(await printed(layer)).toEqual([
      'folder:3  claimed    Ticket 3 (Claim: Engine engine-1234, no Runner yet, process 1, host memory)',
    ]);
  });

  it('prints the reason, the attempt count, and the Ticket Worktree of an escalated ticket', async () => {
    const layer = setup([ticket(5)], { escalations: [escalationOf(id(5))] });

    expect(await printed(layer)).toEqual([
      'folder:5  escalated  Ticket 5 (Escalation: strategy failure, 2 attempts, Ticket Worktree /repo/.sandcastle/worktrees/ticket-5)',
    ]);
  });

  it('prints that no ticket is in scope', async () => {
    expect(await printed(setup([]))).toEqual(['No tickets are in scope']);
  });
});
