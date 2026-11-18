import { Console, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { UnreadableTicket } from '~/Core/Tickets/Domain/Entities/UnreadableTicket/entity';
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
    blockedBy: [],
    body: '',
    ...fields,
  });

// A fake Source that keeps tickets in memory, in the order given. A read for the
// tickets in scope returns every one of them, narrowed only by Project.
const fakeSource = (tickets: readonly Ticket[], unreadable: readonly UnreadableTicket[] = []) => {
  const read = (query: TicketQuery) =>
    tickets.filter(
      (candidate) =>
        (query.id === undefined || candidate.id === query.id) &&
        (query.project === undefined || candidate.project === query.project)
    );
  return Layer.succeed(TicketSource, {
    getOneBy: (query) =>
      Effect.suspend(() => {
        const [found] = read(query);
        return found === undefined ? Effect.fail(new TicketNotFound()) : Effect.succeed(found);
      }),
    getManyBy: (query) => Effect.sync(() => read(query)),
    getUnreadable: Effect.succeed(unreadable),
    report: () => Effect.void,
    reportDone: () => Effect.succeed(Effect.void),
  });
};

// The Ledger runs process 1 on the host `memory`; a Claim of another process on
// that host is a Stale Claim.
const claimOf = (ticket: TicketId, process = 1) =>
  new Claim({ ticket, engine, process, host: 'memory', runner });

const escalationOf = (ticket: TicketId) =>
  new Escalation({ ticket, reason: 'strategy failure: step 2, verdict other than pass', attempts: 2, worktree: '/repo/.sandcastle/worktrees/ticket-5' });

const setup = (
  tickets: readonly Ticket[],
  {
    claims = [],
    escalations = [],
    done = [],
    unreadable = [],
  }: {
    readonly claims?: readonly Claim[];
    readonly escalations?: readonly Escalation[];
    readonly done?: readonly TicketId[];
    readonly unreadable?: readonly UnreadableTicket[];
  } = {}
) => {
  const ledger = makeLedgerMemory();
  for (const ticket of done) {
    ledger.done.add(ticket);
  }
  for (const claim of claims) {
    ledger.claims.set(claim.ticket, claim);
  }
  for (const escalation of escalations) {
    ledger.escalated.set(escalation.ticket, escalation);
  }
  return Layer.merge(fakeSource(tickets, unreadable), ledger.layer);
};

const statusesOf = (layer: ReturnType<typeof setup>, command: ShowStatusCommand = {}) =>
  Effect.runPromise(
    ticketStatuses(command).pipe(
      Effect.map((lines) =>
        lines.map((line) =>
          line.status === 'unreadable' ? ([line.unreadable.name, line.status] as const) : ([line.ticket.id, line.status] as const)
        )
      ),
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
        ticket(1, { doneInSource: true }),
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
      [ticket(1, { ...several, doneInSource: true }), ticket(2, several), ticket(3, several), ticket(4, several)],
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

  it('counts a ticket whose only Claim is a Stale Claim as unclaimed, and shows that Claim as stale', async () => {
    const stale = claimOf(id(1), 4242);
    const layer = setup([ticket(1), ticket(2, { hitl: 'yes' })], { claims: [stale, claimOf(id(2), 4243)] });

    const lines = await Effect.runPromise(ticketStatuses({}).pipe(Effect.provide(layer)));

    expect(
      lines.map((line) =>
        line.status === 'unreadable' ? [] : [line.ticket.id, line.status, line.claim, line.staleClaim]
      )
    ).toEqual([
      [id(1), 'eligible', undefined, stale],
      [id(2), 'not ready', undefined, claimOf(id(2), 4243)],
    ]);
  });

  it('lists only the tickets of the Project when a Project is given', async () => {
    const layer = setup([ticket(1), ticket(2, { project: web }), ticket(3)]);

    expect(await statusesOf(layer, { project: billing })).toEqual([
      [id(1), 'eligible'],
      [id(3), 'eligible'],
    ]);
  });

  it('resolves a blocker of another Project when a Project is given', async () => {
    const layer = setup([ticket(1, { project: web, doneInSource: true }), ticket(2, { blockedBy: [id(1)] })]);

    expect(await statusesOf(layer, { project: billing })).toEqual([[id(2), 'eligible']]);
  });

  it('shows done for a ticket that the Ledger records as done while its file is still open, and unblocks its dependent', async () => {
    const layer = setup([ticket(1), ticket(2, { blockedBy: [id(1)] })], { done: [id(1)] });

    expect(await statusesOf(layer)).toEqual([
      [id(1), 'done'],
      [id(2), 'eligible'],
    ]);
  });
});

// The unreadable tickets of a folder, one for each reason.
const unreadable = [
  new UnreadableTicket({ name: 'README.md', reason: 'no numeric prefix' }),
  new UnreadableTicket({
    name: '07-broken.md',
    id: id(7),
    reason: 'unparseable front matter',
    detail: 'it has no closing `---`',
  }),
  new UnreadableTicket({ name: '08-unknown-kind.md', id: id(8), reason: 'invalid hint', detail: 'Expected a kind at ["kind"]' }),
];

describe('ticketStatuses, unreadable tickets and blockers', () => {
  it('lists every unreadable ticket under the Ticket Status unreadable, with its reason, after the tickets', async () => {
    const layer = setup([ticket(1)], { unreadable });

    const lines = await Effect.runPromise(ticketStatuses({}).pipe(Effect.provide(layer)));

    expect(lines.map((line) => (line.status === 'unreadable' ? [line.status, line.unreadable] : [line.status]))).toEqual([
      ['eligible'],
      ['unreadable', unreadable[0]],
      ['unreadable', unreadable[1]],
      ['unreadable', unreadable[2]],
    ]);
  });

  it('lists the unreadable tickets whatever the Project', async () => {
    const layer = setup([ticket(1)], { unreadable });

    expect(await statusesOf(layer, { project: web })).toEqual([
      ['README.md', 'unreadable'],
      ['07-broken.md', 'unreadable'],
      ['08-unknown-kind.md', 'unreadable'],
    ]);
  });

  it('shows which blockers of a blocked ticket are open and which are unresolved', async () => {
    const layer = setup(
      [
        ticket(1, { hitl: 'yes' }),
        ticket(2, { doneInSource: true }),
        ticket(3, { blockedBy: [id(1), id(2), id(9), formatTicketId('folder', 'A title')] }),
      ],
    );

    const lines = await Effect.runPromise(ticketStatuses({}).pipe(Effect.provide(layer)));

    expect(lines.flatMap((line) => (line.status === 'blocked' ? [[line.ticket.id, line.blockers]] : []))).toEqual([
      [id(3), { open: [id(1)], unresolved: [id(9), formatTicketId('folder', 'A title')] }],
    ]);
  });

  it('shows the unresolved blockers of a ticket that is not blocked, each blocker once', async () => {
    const layer = setup([ticket(1), ticket(2, { hitl: 'yes', blockedBy: [id(1), id(9), id(9)] })]);

    expect(await printed(layer)).toEqual([
      'folder:1  Ticket 1  eligible',
      'folder:2  Ticket 2  not ready  (Blockers: unresolved folder:9)',
    ]);
  });

  it('does not count a blocker that the Source finds by its identity as done as outstanding', async () => {
    // Like the Linear Source, this Source leaves done tickets out of a read of many,
    // and finds them by identity.
    const done = ticket(1, { doneInSource: true });
    const open = ticket(2, { blockedBy: [id(1), id(9)] });
    const source = Effect.runSync(TicketSource.pipe(Effect.provide(fakeSource([done, open]))));
    const layer = Layer.merge(
      Layer.succeed(TicketSource, { ...source, getManyBy: () => Effect.succeed([open]) }),
      makeLedgerMemory().layer
    );

    const lines = await Effect.runPromise(ticketStatuses({}).pipe(Effect.provide(layer)));

    expect(lines.flatMap((line) => (line.status === 'blocked' ? [line.blockers] : []))).toEqual([
      { open: [], unresolved: [id(9)] },
    ]);
  });

  it('counts a blocker of another Project that the Source finds by its identity as open', async () => {
    const layer = setup([ticket(1, { project: web, hitl: 'yes' }), ticket(2, { blockedBy: [id(1)] })]);

    const lines = await Effect.runPromise(ticketStatuses({ project: billing }).pipe(Effect.provide(layer)));

    expect(lines.flatMap((line) => (line.status === 'blocked' ? [line.blockers] : []))).toEqual([
      { open: [id(1)], unresolved: [] },
    ]);
  });
});

describe('showStatus', () => {
  it('prints the identity, the Title, and the Ticket Status of every ticket', async () => {
    const layer = setup([ticket(1, { doneInSource: true }), ticket(2)]);

    expect(await printed(layer)).toEqual(['folder:1  Ticket 1  done', 'folder:2  Ticket 2  eligible']);
  });

  it('aligns the Title and Ticket Status columns across tickets', async () => {
    const layer = setup([ticket(1, { title: 'Short' }), ticket(12, { title: 'A longer title', blockedBy: [id(1)] })]);

    expect(await printed(layer)).toEqual([
      'folder:1   Short           eligible',
      'folder:12  A longer title  blocked  (Blockers: open folder:1)',
    ]);
  });

  it('prints the Engine, the Runner, the process, and the host of the Claim of a claimed ticket', async () => {
    const layer = setup([ticket(3)], { claims: [claimOf(id(3))] });

    expect(await printed(layer)).toEqual([
      'folder:3  Ticket 3  claimed  (Claim: Engine engine-1234, Runner engine-1234:runner-a, process 1, host memory)',
    ]);
  });

  it('prints the holder of a Stale Claim, marked stale, with the Ticket Status the ticket has without it', async () => {
    const layer = setup([ticket(3), ticket(4, { blockedBy: [id(9)] })], {
      claims: [claimOf(id(3), 4242), new Claim({ ticket: id(4), engine, process: 4243, host: 'memory' })],
    });

    expect(await printed(layer)).toEqual([
      'folder:3  Ticket 3  eligible  (Stale Claim: Engine engine-1234, Runner engine-1234:runner-a, process 4242, host memory)',
      'folder:4  Ticket 4  blocked  (Stale Claim: Engine engine-1234, no Runner yet, process 4243, host memory)  (Blockers: unresolved folder:9)',
    ]);
  });

  it('prints a Stale Claim left on an escalated ticket with its Escalation', async () => {
    const layer = setup([ticket(5)], { claims: [claimOf(id(5), 4242)], escalations: [escalationOf(id(5))] });

    expect(await printed(layer)).toEqual([
      'folder:5  Ticket 5  escalated  (Stale Claim: Engine engine-1234, Runner engine-1234:runner-a, process 4242, host memory)  (Escalation: strategy failure: step 2, verdict other than pass, 2 attempts, Ticket Worktree /repo/.sandcastle/worktrees/ticket-5)',
    ]);
  });

  it('prints a Claim that has no Runner yet', async () => {
    const claim = new Claim({ ticket: id(3), engine, process: 1, host: 'memory' });
    const layer = setup([ticket(3)], { claims: [claim] });

    expect(await printed(layer)).toEqual([
      'folder:3  Ticket 3  claimed  (Claim: Engine engine-1234, no Runner yet, process 1, host memory)',
    ]);
  });

  it('prints the reason, the attempt count, and the Ticket Worktree of an escalated ticket', async () => {
    const layer = setup([ticket(5)], { escalations: [escalationOf(id(5))] });

    expect(await printed(layer)).toEqual([
      'folder:5  Ticket 5  escalated  (Escalation: strategy failure: step 2, verdict other than pass, 2 attempts, Ticket Worktree /repo/.sandcastle/worktrees/ticket-5)',
    ]);
  });

  it('prints each unreadable ticket with its reason, and a dash for a file with no identity', async () => {
    const layer = setup([ticket(1)], { unreadable });

    expect(await printed(layer)).toEqual([
      'folder:1  Ticket 1            eligible',
      '-         README.md           unreadable  (no numeric prefix)',
      'folder:7  07-broken.md        unreadable  (unparseable front matter: it has no closing `---`)',
      'folder:8  08-unknown-kind.md  unreadable  (invalid hint: Expected a kind at ["kind"])',
    ]);
  });

  it('prints a folder and a ticket file that cannot be read, with the reason', async () => {
    const layer = setup([ticket(1)], {
      unreadable: [
        new UnreadableTicket({
          name: 'web/',
          reason: 'folder cannot be read',
          detail: 'PermissionDenied: FileSystem.readDirectory (/repo/tickets/web)',
        }),
        new UnreadableTicket({
          name: '02-locked.md',
          id: id(2),
          reason: 'file cannot be read',
          detail: 'PermissionDenied: FileSystem.readFile (/repo/tickets/02-locked.md)',
        }),
      ],
    });

    expect(await printed(layer)).toEqual([
      'folder:1  Ticket 1      eligible',
      '-         web/          unreadable  (folder cannot be read: PermissionDenied: FileSystem.readDirectory (/repo/tickets/web))',
      'folder:2  02-locked.md  unreadable  (file cannot be read: PermissionDenied: FileSystem.readFile (/repo/tickets/02-locked.md))',
    ]);
  });

  it('prints the open and the unresolved blockers of a blocked ticket', async () => {
    const layer = setup([ticket(1, { hitl: 'yes' }), ticket(3, { blockedBy: [id(1), id(9)] }), ticket(4, { blockedBy: [id(1)] })]);

    expect(await printed(layer)).toEqual([
      'folder:1  Ticket 1  not ready',
      'folder:3  Ticket 3  blocked  (Blockers: open folder:1; unresolved folder:9)',
      'folder:4  Ticket 4  blocked  (Blockers: open folder:1)',
    ]);
  });

  it('prints that no ticket is in scope', async () => {
    expect(await printed(setup([]))).toEqual(['No tickets are in scope']);
  });
});
