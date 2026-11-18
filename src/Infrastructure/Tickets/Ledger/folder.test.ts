import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Layer, Path, type PlatformError, Result, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, test } from 'vitest';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketAlreadyClaimed } from '~/Core/Tickets/Domain/Exceptions/TicketAlreadyClaimed';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';

import { ledgerFolder, LedgerFolderLive } from './folder';

const holder = { process: 4242, host: 'test-host' };
const first = Schema.decodeSync(EngineId)('amber-oak-0001');
const second = Schema.decodeSync(EngineId)('brisk-fox-0002');
const runner = Schema.decodeSync(RunnerId)('amber-oak-0001:0');
const ticket = (value: number) => formatTicketId('folder', String(value));

const gitCommonDir = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.makeTempDirectory({ prefix: 'engine-ledger-' }))
);

const inLedger = <A, E>(dir: string, use: Effect.Effect<A, E, Ledger>) =>
  use.pipe(Effect.provide(ledgerFolder(dir, holder)));

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>
) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

test('of two competing Claims on one ticket exactly one succeeds', async () => {
  const outcomes = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      const claimBy = (engine: EngineId) =>
        inLedger(dir, Ledger.pipe(Effect.flatMap((ledger) => ledger.claim(ticket(1), engine)), Effect.result));
      return yield* Effect.all([claimBy(first), claimBy(second)], { concurrency: 'unbounded' });
    })
  );

  expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
  expect(outcomes.filter(Result.isFailure).map((outcome) => outcome.failure)).toEqual([
    new TicketAlreadyClaimed({ ticketId: ticket(1) }),
  ]);
});

test('a release removes the Claim, so the ticket can be claimed again', async () => {
  const { afterRelease, again } = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      return yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.claim(ticket(1), first);
          yield* ledger.release(ticket(1));
          const afterRelease = yield* ledger.read([ticket(1)]);
          const again = yield* ledger.claim(ticket(1), second);
          return { afterRelease, again };
        })
      );
    })
  );

  expect(afterRelease.size).toBe(0);
  expect(again.engine).toBe(second);
});

test('releasing a ticket with no Claim does nothing', async () => {
  const claims = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      return yield* inLedger(
        dir,
        Ledger.pipe(
          Effect.tap((ledger) => ledger.release(ticket(1))),
          Effect.flatMap((ledger) => ledger.read([ticket(1)]))
        )
      );
    })
  );

  expect(claims.size).toBe(0);
});

test('releasing all Claims of one Engine leaves the Claims of another Engine in place', async () => {
  const { released, claims } = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      return yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.claim(ticket(1), first);
          yield* ledger.claim(ticket(2), second);
          yield* ledger.claim(ticket(3), first);
          const released = yield* ledger.releaseAllOf(first);
          const claims = yield* ledger.read([ticket(1), ticket(2), ticket(3)]);
          return { released, claims };
        })
      );
    })
  );

  expect([...released].toSorted()).toEqual([ticket(1), ticket(3)]);
  expect([...claims.keys()]).toEqual([ticket(2)]);
  expect(claims.get(ticket(2))?.engine).toBe(second);
});

test('the record names the Engine, the process, and the host, and gains the Runner', async () => {
  const { claimed, assigned } = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      return yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.claim(ticket(1), first);
          const claimed = yield* ledger.read([ticket(1)]);
          yield* ledger.assignRunner(ticket(1), runner);
          const assigned = yield* ledger.read([ticket(1)]);
          return { claimed, assigned };
        })
      );
    })
  );

  expect(claimed.get(ticket(1))).toEqual(
    new Claim({ ticket: ticket(1), engine: first, process: holder.process, host: holder.host })
  );
  expect(assigned.get(ticket(1))).toEqual(
    new Claim({ ticket: ticket(1), engine: first, process: holder.process, host: holder.host, runner })
  );
});

test('a second Ledger on the same Git common directory sees the Claims of the first', async () => {
  const claims = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      yield* inLedger(dir, Ledger.pipe(Effect.flatMap((ledger) => ledger.claim(ticket(1), first))));
      return yield* inLedger(dir, Ledger.pipe(Effect.flatMap((ledger) => ledger.read([ticket(1), ticket(2)]))));
    })
  );

  expect([...claims.keys()]).toEqual([ticket(1)]);
});

test('an escalation records the reason, the attempt count, and the retained Ticket Worktree', async () => {
  const { escalated, escalations } = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      return yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const escalated = yield* ledger.escalate(ticket(1), { reason: 'strategy failure', worktree: '/wt/ticket-1' });
          const escalations = yield* ledger.escalations([ticket(1), ticket(2)]);
          return { escalated, escalations };
        })
      );
    })
  );
  const expected = new Escalation({ ticket: ticket(1), reason: 'strategy failure', attempts: 1, worktree: '/wt/ticket-1' });
  expect(escalated).toEqual(expected);
  expect([...escalations.entries()]).toEqual([[ticket(1), expected]]);
});

test('a second failure of the same ticket raises its attempt count', async () => {
  const escalations = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      yield* inLedger(
        dir,
        Ledger.pipe(Effect.flatMap((ledger) => ledger.escalate(ticket(1), { reason: 'first', worktree: '/wt/1' })))
      );
      return yield* inLedger(
        dir,
        Ledger.pipe(
          Effect.tap((ledger) => ledger.escalate(ticket(1), { reason: 'second', worktree: '/wt/1' })),
          Effect.flatMap((ledger) => ledger.escalations([ticket(1)]))
        )
      );
    })
  );
  expect(escalations.get(ticket(1))).toEqual(
    new Escalation({ ticket: ticket(1), reason: 'second', attempts: 2, worktree: '/wt/1' })
  );
});

test('clearing an escalation leaves the ticket not escalated, and the next escalation keeps counting', async () => {
  const { afterClear, again } = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      const afterClear = yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.escalate(ticket(1), { reason: 'first', worktree: '/wt/1' });
          yield* ledger.escalate(ticket(1), { reason: 'second', worktree: '/wt/1' });
          yield* ledger.clearEscalation(ticket(1));
          return yield* ledger.escalations([ticket(1)]);
        })
      );
      const again = yield* inLedger(
        dir,
        Ledger.pipe(Effect.flatMap((ledger) => ledger.escalate(ticket(1), { reason: 'third', worktree: '/wt/1' })))
      );
      return { afterClear, again };
    })
  );

  expect(afterClear.size).toBe(0);
  expect(again).toEqual(new Escalation({ ticket: ticket(1), reason: 'third', attempts: 3, worktree: '/wt/1' }));
});

test('clearing a ticket that is not escalated does nothing', async () => {
  const escalations = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      return yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.escalate(ticket(1), { reason: 'strategy failure', worktree: '/wt/1' });
          yield* ledger.clearEscalation(ticket(2));
          return yield* ledger.escalations([ticket(1), ticket(2)]);
        })
      );
    })
  );

  expect([...escalations.keys()]).toEqual([ticket(1)]);
});

test('an escalation leaves the Claims in place, and a Claim leaves the ticket not escalated', async () => {
  const { claims, escalations } = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      return yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          yield* ledger.claim(ticket(1), first);
          yield* ledger.claim(ticket(2), first);
          yield* ledger.escalate(ticket(1), { reason: 'strategy failure', worktree: '/wt/1' });
          const claims = yield* ledger.read([ticket(1), ticket(2)]);
          const escalations = yield* ledger.escalations([ticket(1), ticket(2)]);
          return { claims, escalations };
        })
      );
    })
  );
  expect([...claims.keys()]).toEqual([ticket(1), ticket(2)]);
  expect([...escalations.keys()]).toEqual([ticket(1)]);
});

// A process that ran on this host and has exited.
const deadProcess = ChildProcessSpawner.ChildProcessSpawner.pipe(
  Effect.flatMap((spawner) => spawner.spawn(ChildProcess.make(process.execPath, ['-e', '']))),
  Effect.tap((child) => child.exitCode),
  Effect.map((child): number => child.pid),
  Effect.scoped
);

// The Claim that a Ledger of the holder on the given host makes on ticket 1, read
// back by a Ledger of the test holder, with whether that Ledger finds it stale.
const staleness = (
  host: string,
  processOf: Effect.Effect<number, PlatformError.PlatformError, ChildProcessSpawner.ChildProcessSpawner>
) =>
  run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      const other = { process: yield* processOf, host };
      yield* Ledger.pipe(
        Effect.flatMap((ledger) => ledger.claim(ticket(1), second)),
        Effect.provide(ledgerFolder(dir, other))
      );
      return yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const held = (yield* ledger.read([ticket(1)])).get(ticket(1))!;
          return yield* ledger.isStale(held);
        })
      );
    })
  );

test('a Claim of a process that no longer runs on this host is stale', async () => {
  expect(await staleness(holder.host, deadProcess)).toBe(true);
});

test('a Claim of a process that runs on this host is not stale', async () => {
  expect(await staleness(holder.host, Effect.succeed(process.pid))).toBe(false);
});

test('a Claim from another host is not stale, even when no such process runs here', async () => {
  expect(await staleness('other-host', deadProcess)).toBe(false);
});

test('releasing a stale Claim removes it, and leaves a Claim made since then in place', async () => {
  const { afterStale, afterReplaced } = await run(
    Effect.gen(function* () {
      const dir = yield* gitCommonDir;
      const dead = { process: yield* deadProcess, host: holder.host };
      yield* Ledger.pipe(
        Effect.flatMap((ledger) => ledger.claim(ticket(1), second)),
        Effect.provide(ledgerFolder(dir, dead))
      );
      return yield* inLedger(
        dir,
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const stale = (yield* ledger.read([ticket(1)])).get(ticket(1))!;
          yield* ledger.releaseStale(stale);
          const afterStale = yield* ledger.read([ticket(1)]);
          yield* ledger.claim(ticket(1), first);
          yield* ledger.releaseStale(stale);
          const afterReplaced = yield* ledger.read([ticket(1)]);
          return { afterStale, afterReplaced };
        })
      );
    })
  );

  expect(afterStale.size).toBe(0);
  expect(afterReplaced.get(ticket(1))?.engine).toBe(first);
});

const git = (dir: string, args: string[]) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) => spawner.string(ChildProcess.make('git', args, { cwd: dir }))),
    Effect.map((output) => output.trim())
  );

test('the Ledger of a Repository Root keeps its records in a folder for Rippls inside the Git common directory', async () => {
  const { records, common } = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: 'engine-ledger-repo-' });
      yield* git(root, ['init', '-b', 'main']);
      yield* Ledger.pipe(
        Effect.flatMap((ledger) => ledger.claim(ticket(1), first)),
        Effect.provide(LedgerFolderLive(holder).pipe(Layer.provide(Layer.succeed(RepositoryRoot, root))))
      );
      const common = yield* fs.realPath(path.join(root, '.git'));
      const records = yield* fs.readDirectory(path.join(common, 'rippls', 'ledger'));
      return { records, common };
    }).pipe(Effect.provide(NodeServices.layer))
  );

  expect(common.endsWith('.git')).toBe(true);
  expect(records).toEqual([`${encodeURIComponent(ticket(1))}.json`]);
});
