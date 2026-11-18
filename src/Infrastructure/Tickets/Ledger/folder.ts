import { Effect, FileSystem, Layer, Option, Path, type PlatformError, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { LedgerError } from '~/Core/Tickets/Domain/Exceptions/LedgerError';
import { TicketAlreadyClaimed } from '~/Core/Tickets/Domain/Exceptions/TicketAlreadyClaimed';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';

import type { ClaimHolder } from './holder';

const RECORD_SUFFIX = '.json';

const ClaimJson = Schema.fromJsonString(Claim);
const encodeClaim = Schema.encodeSync(ClaimJson);
const decodeClaim = Schema.decodeUnknownOption(ClaimJson);

const isReason = (tag: PlatformError.SystemErrorTag) => (error: PlatformError.PlatformError) =>
  error.reason._tag === tag;

const isNotFound = isReason('NotFound');
const isAlreadyExists = isReason('AlreadyExists');

const toLedgerError = (cause: unknown) => new LedgerError({ cause });

/**
 * The Ledger as one record per ticket in a folder for Rippls inside the Git common
 * directory. Every worktree of the repository shares that directory, it never
 * appears in a merge, and it needs no ignore rule.
 */
export const ledgerFolder = (gitCommonDir: string, holder: ClaimHolder) =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(gitCommonDir, 'rippls', 'ledger');
      const recordOf = (ticket: TicketId) => path.join(dir, `${encodeURIComponent(ticket)}${RECORD_SUFFIX}`);

      // A record is written whole in a scratch folder next to the records, so a
      // reader never sees a partial record.
      const writeScratch = (claim: Claim) =>
        fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.andThen(fs.makeTempDirectoryScoped({ directory: dir, prefix: '.scratch-' })),
          Effect.map((scratch) => path.join(scratch, 'record.json')),
          Effect.tap((file) => fs.writeFileString(file, encodeClaim(claim))),
          Effect.mapError(toLedgerError)
        );

      const readRecord = (file: string): Effect.Effect<Option.Option<Claim>, LedgerError> =>
        fs.readFileString(file).pipe(
          Effect.map(decodeClaim),
          Effect.catchIf(isNotFound, () => Effect.succeedNone),
          Effect.mapError(toLedgerError)
        );

      const removeRecord = (file: string) =>
        fs.remove(file).pipe(Effect.catchIf(isNotFound, () => Effect.void), Effect.mapError(toLedgerError));

      // A hard link fails when the record exists, so only one caller creates it.
      const claim = (ticket: TicketId, engine: EngineId) => {
        const made = new Claim({ ticket, engine, process: holder.process, host: holder.host });
        const link = (scratch: string) =>
          fs
            .link(scratch, recordOf(ticket))
            .pipe(
              Effect.mapError((error) =>
                isAlreadyExists(error) ? new TicketAlreadyClaimed({ ticketId: ticket }) : toLedgerError(error)
              )
            );
        return writeScratch(made).pipe(Effect.flatMap(link), Effect.scoped, Effect.as(made));
      };

      const assignRunner = (ticket: TicketId, runner: RunnerId) =>
        Effect.gen(function* () {
          const held = yield* readRecord(recordOf(ticket));
          if (Option.isNone(held)) {
            return yield* toLedgerError(`The Ledger holds no Claim on ${ticket}`);
          }
          const scratch = yield* writeScratch(held.value.withRunner(runner));
          yield* fs.rename(scratch, recordOf(ticket)).pipe(Effect.mapError(toLedgerError));
        }).pipe(Effect.scoped);

      const release = (ticket: TicketId) => removeRecord(recordOf(ticket));

      const records = fs.readDirectory(dir).pipe(
        Effect.catchIf(isNotFound, () => Effect.succeed<string[]>([])),
        Effect.mapError(toLedgerError),
        Effect.map((files) => files.filter((file) => file.endsWith(RECORD_SUFFIX))),
        Effect.flatMap((files) => Effect.forEach(files, (file) => readRecord(path.join(dir, file)))),
        Effect.map((claims) => claims.flatMap(Option.toArray))
      );

      const releaseAllOf = (engine: EngineId) =>
        records.pipe(
          Effect.map((claims) => claims.filter((held) => held.engine === engine).map((held) => held.ticket)),
          Effect.tap((tickets) => Effect.forEach(tickets, release, { discard: true }))
        );

      const read = (tickets: readonly TicketId[]) =>
        Effect.forEach(tickets, (ticket) => readRecord(recordOf(ticket))).pipe(
          Effect.map(
            (claims) => new Map(claims.flatMap(Option.toArray).map((held) => [held.ticket, held] as const))
          )
        );

      return { claim, assignRunner, release, releaseAllOf, read };
    })
  );

const gitCommonDir = Effect.gen(function* () {
  const root = yield* RepositoryRoot;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner.string(ChildProcess.make('git', ['rev-parse', '--git-common-dir'], { cwd: root }));
  return path.resolve(root, output.trim());
});

/** The Ledger of the Repository Root, for Claims made by this process on this host. */
export const LedgerFolderLive = (holder: ClaimHolder) =>
  Layer.unwrap(gitCommonDir.pipe(Effect.map((dir) => ledgerFolder(dir, holder))));
