import { Effect, FileSystem, Layer, Option, Path, type PlatformError, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Escalation } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import type { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { LedgerError } from '~/Core/Tickets/Domain/Exceptions/LedgerError';
import { TicketAlreadyClaimed } from '~/Core/Tickets/Domain/Exceptions/TicketAlreadyClaimed';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';

import { type ClaimHolder, isStaleFor } from './holder';

const RECORD_SUFFIX = '.json';

const ClaimJson = Schema.fromJsonString(Claim);
const encodeClaim = Schema.encodeSync(ClaimJson);
const decodeClaim = Schema.decodeUnknownOption(ClaimJson);
const EscalationJson = Schema.fromJsonString(Escalation);
const encodeEscalation = Schema.encodeSync(EscalationJson);
const decodeEscalation = Schema.decodeUnknownOption(EscalationJson);
const isReason = (tag: PlatformError.SystemErrorTag) => (error: PlatformError.PlatformError) =>
  error.reason._tag === tag;

const isNotFound = isReason('NotFound');
const isAlreadyExists = isReason('AlreadyExists');

const toLedgerError = (cause: unknown) => new LedgerError({ cause });

// Signal 0 tests that a process exists without signalling it. Only ESRCH says
// that no such process runs; a process of another user answers EPERM.
const processRuns = (pid: number): Effect.Effect<boolean> =>
  Effect.try({
    try: () => process.kill(pid, 0),
    catch: (error) => (error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN'),
  }).pipe(Effect.match({ onSuccess: () => true, onFailure: (code) => code !== 'ESRCH' }));

/**
 * The Ledger as one record per ticket in a folder for Rippls inside the Git common
 * directory. Every worktree of the repository shares that directory, it never
 * appears in a merge, and it needs no ignore rule. A Claim is the record in the
 * folder itself; an escalation is a record in its `escalations` folder, so it
 * outlives the Claim that is released when the ticket is escalated.
 */
export const ledgerFolder = (gitCommonDir: string, holder: ClaimHolder) =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(gitCommonDir, 'rippls', 'ledger');
      const escalationsDir = path.join(dir, 'escalations');
      const fileName = (ticket: TicketId) => `${encodeURIComponent(ticket)}${RECORD_SUFFIX}`;
      const recordOf = (ticket: TicketId) => path.join(dir, fileName(ticket));
      const escalationOf = (ticket: TicketId) => path.join(escalationsDir, fileName(ticket));

      // A record is written whole in a scratch folder next to the records, so a
      // reader never sees a partial record.
      const writeScratch = (content: string) =>
        fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.andThen(fs.makeTempDirectoryScoped({ directory: dir, prefix: '.scratch-' })),
          Effect.map((scratch) => path.join(scratch, 'record.json')),
          Effect.tap((file) => fs.writeFileString(file, content)),
          Effect.mapError(toLedgerError)
        );

      const readWith =
        <A>(decode: (text: string) => Option.Option<A>) =>
        (file: string): Effect.Effect<Option.Option<A>, LedgerError> =>
          fs.readFileString(file).pipe(
            Effect.map(decode),
            Effect.catchIf(isNotFound, () => Effect.succeedNone),
            Effect.mapError(toLedgerError)
          );
      const readRecord = readWith(decodeClaim);
      const readEscalation = readWith(decodeEscalation);

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
        return writeScratch(encodeClaim(made)).pipe(Effect.flatMap(link), Effect.scoped, Effect.as(made));
      };

      const assignRunner = (ticket: TicketId, runner: RunnerId) =>
        Effect.gen(function* () {
          const held = yield* readRecord(recordOf(ticket));
          if (Option.isNone(held)) {
            return yield* toLedgerError(`The Ledger holds no Claim on ${ticket}`);
          }
          const scratch = yield* writeScratch(encodeClaim(held.value.withRunner(runner)));
          yield* fs.rename(scratch, recordOf(ticket)).pipe(Effect.mapError(toLedgerError));
        }).pipe(Effect.scoped);

      const release = (ticket: TicketId) => removeRecord(recordOf(ticket));

      const isStale = isStaleFor(holder, processRuns);

      // The stale record is moved aside under a name of its own, which only one
      // caller can do to one record, and checked there. When another Engine
      // replaced the same stale Claim first, the record moved aside is that
      // Engine's Claim, and it is put back.
      const releaseStale = (stale: Claim) =>
        Effect.gen(function* () {
          const record = recordOf(stale.ticket);
          const held = yield* readRecord(record);
          if (!Option.exists(held, (current) => current.isSameClaim(stale))) {
            return;
          }
          const scratch = yield* fs
            .makeTempDirectoryScoped({ directory: dir, prefix: '.scratch-' })
            .pipe(Effect.mapError(toLedgerError));
          const aside = path.join(scratch, 'record.json');
          const moved = yield* fs.rename(record, aside).pipe(
            Effect.as(true),
            Effect.catchIf(isNotFound, () => Effect.succeed(false)),
            Effect.mapError(toLedgerError)
          );
          if (!moved) {
            return;
          }
          const movedClaim = yield* readRecord(aside);
          if (!Option.exists(movedClaim, (current) => current.isSameClaim(stale))) {
            yield* fs.link(aside, record).pipe(Effect.mapError(toLedgerError));
          }
        }).pipe(Effect.scoped);

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

      // Only the Engine that holds the Claim escalates a ticket, so the attempt
      // count is read and raised without a race.
      const escalate = (ticket: TicketId, { reason, worktree }: { readonly reason: string; readonly worktree: string }) =>
        Effect.gen(function* () {
          const previous = yield* readEscalation(escalationOf(ticket));
          const attempts = Option.match(previous, { onNone: () => 0, onSome: (held) => held.attempts }) + 1;
          const escalation = new Escalation({ ticket, reason, attempts, worktree });
          const scratch = yield* writeScratch(encodeEscalation(escalation));
          yield* fs.makeDirectory(escalationsDir, { recursive: true }).pipe(
            Effect.andThen(fs.rename(scratch, escalationOf(ticket))),
            Effect.mapError(toLedgerError)
          );
          return escalation;
        }).pipe(Effect.scoped);

      const escalations = (tickets: readonly TicketId[]) =>
        Effect.forEach(tickets, (ticket) => readEscalation(escalationOf(ticket))).pipe(
          Effect.map((found) => new Map(found.flatMap(Option.toArray).map((held) => [held.ticket, held] as const)))
        );

      return { claim, assignRunner, release, isStale, releaseStale, releaseAllOf, read, escalate, escalations };
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
