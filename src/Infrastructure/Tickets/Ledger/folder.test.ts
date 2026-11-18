import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Layer, Path, Result, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, test } from 'vitest';

import { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
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

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
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
