import { Effect, Exit, FileSystem, Layer, Option, Path, type PlatformError, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import type { EngineId } from '~/Core/Shared/Domain/Properties/EngineId';
import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Claim } from '~/Core/Tickets/Domain/Entities/Claim/entity';
import { Escalation, type EscalationCause } from '~/Core/Tickets/Domain/Entities/Escalation/entity';
import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
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
const encodeDone = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ ticket: TicketId })));
const isReason = (tag: PlatformError.SystemErrorTag) => (error: PlatformError.PlatformError) =>
  error.reason._tag === tag;

const isNotFound = isReason('NotFound');
const isAlreadyExists = isReason('AlreadyExists');

const toLedgerError = (cause: unknown) => new LedgerError({ cause });

const isSameClaimAs = (claim: Claim) => (other: Claim) => other.isSameClaim(claim);

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
 * folder itself; an Escalation is a record in its `escalations` folder, so it
 * outlives the Claim that is released when the ticket is escalated. A cleared
 * Escalation moves to the `cleared` folder, which keeps its attempt count. A done
 * ticket has a record in the `done` folder. The `replacing` folder holds the new
 * Claim of a replace of a Stale Claim until it is written over the stale record.
 */
export const ledgerFolder = (gitCommonDir: string, holder: ClaimHolder) =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(gitCommonDir, 'rippls', 'ledger');
      const escalationsDir = path.join(dir, 'escalations');
      const clearedDir = path.join(dir, 'cleared');
      const doneDir = path.join(dir, 'done');
      const replacingDir = path.join(dir, 'replacing');
      const fileName = (ticket: TicketId) => `${encodeURIComponent(ticket)}${RECORD_SUFFIX}`;
      const recordOf = (ticket: TicketId) => path.join(dir, fileName(ticket));
      const escalationOf = (ticket: TicketId) => path.join(escalationsDir, fileName(ticket));
      const clearedOf = (ticket: TicketId) => path.join(clearedDir, fileName(ticket));
      const doneOf = (ticket: TicketId) => path.join(doneDir, fileName(ticket));
      const replacingOf = (ticket: TicketId) => path.join(replacingDir, fileName(ticket));

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

      // The records of the given tickets, keyed by ticket. A ticket with no record is absent.
      const readMany = <A extends { readonly ticket: TicketId }>(
        tickets: readonly TicketId[],
        readOne: (ticket: TicketId) => Effect.Effect<Option.Option<A>, LedgerError>
      ) =>
        Effect.forEach(tickets, readOne).pipe(
          Effect.map((found) => new Map(found.flatMap(Option.toArray).map((held) => [held.ticket, held] as const)))
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

      // A link in the `replacing` folder is abandoned when the process that made it
      // no longer runs: its replace stopped before the write. It is removed, and so
      // is a link that cannot be read. Whether the name is free again is returned;
      // the link of a process that runs is a replace in progress, and stays.
      const removeAbandoned = (pending: string) =>
        readRecord(pending).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.succeed(true), onSome: isStale })),
          Effect.tap((abandoned) => (abandoned ? removeRecord(pending) : Effect.void))
        );

      // A Stale Claim becomes the new Claim in one write: a rename of the new record
      // onto the stale one, so the ticket's record is always one of the two. A rename
      // does not tell which record it replaced, so the right to make it is taken
      // first, by linking the new record under the ticket's name in the `replacing`
      // folder, which only one caller can do. The record is read again once the link
      // is held, since another caller may have finished its replace before it. The
      // rename then moves that link, so the right ends with the write. A replace
      // that fails removes its link; one whose process stops leaves it, for a later
      // caller to remove as abandoned.
      const replaceStale = (stale: Claim, engine: EngineId) =>
        Effect.gen(function* () {
          const record = recordOf(stale.ticket);
          const pending = replacingOf(stale.ticket);
          const made = new Claim({ ticket: stale.ticket, engine, process: holder.process, host: holder.host });
          const holds = (claim: Claim) => readRecord(record).pipe(Effect.map(Option.exists(isSameClaimAs(claim))));
          if (!(yield* holds(stale))) {
            return false;
          }
          const scratch = yield* writeScratch(encodeClaim(made));
          const link = fs.makeDirectory(replacingDir, { recursive: true }).pipe(
            Effect.andThen(fs.link(scratch, pending)),
            Effect.as(true),
            Effect.catchIf(isAlreadyExists, () => Effect.succeed(false)),
            Effect.mapError(toLedgerError)
          );
          const linkOnceFree = removeAbandoned(pending).pipe(
            Effect.flatMap((free) => (free ? link : Effect.succeed(false)))
          );
          const takeLink = link.pipe(Effect.flatMap((linked) => (linked ? Effect.succeed(true) : linkOnceFree)));
          // The caller won only when the record names its Claim in the end: its link
          // may have been removed and taken by another caller, who read it as
          // abandoned just before, and then the rename moved the link of that caller.
          const write = Effect.gen(function* () {
            if (!(yield* holds(stale))) {
              yield* removeRecord(pending);
              return false;
            }
            yield* fs.rename(pending, record).pipe(
              Effect.catchIf(isNotFound, () => Effect.void),
              Effect.mapError(toLedgerError)
            );
            return yield* holds(made);
          });
          return yield* Effect.acquireUseRelease(
            takeLink,
            (taken) => (taken ? write : Effect.succeed(false)),
            (taken, exit) => (taken && Exit.isFailure(exit) ? Effect.ignore(removeRecord(pending)) : Effect.void)
          );
        }).pipe(Effect.scoped);

      const records = fs.readDirectory(dir).pipe(
        Effect.catchIf(isNotFound, () => Effect.succeed<string[]>([])),
        Effect.mapError(toLedgerError),
        Effect.map((files) => files.filter((file) => file.endsWith(RECORD_SUFFIX))),
        Effect.flatMap((files) => Effect.forEach(files, (file) => readRecord(path.join(dir, file)))),
        Effect.map((claims) => claims.flatMap(Option.toArray))
      );

      const ticketsClaimedBy = (engine: EngineId) =>
        records.pipe(
          Effect.map((claims) => claims.filter((held) => held.engine === engine).map((held) => held.ticket))
        );

      const read = (tickets: readonly TicketId[]) => readMany(tickets, (ticket) => readRecord(recordOf(ticket)));

      // Only the Engine that holds the Claim escalates a ticket, so the attempt
      // count is read and raised without a race. The count continues from a
      // cleared Escalation.
      const escalate = (ticket: TicketId, { reason, worktree }: EscalationCause) =>
        Effect.gen(function* () {
          const current = yield* readEscalation(escalationOf(ticket));
          const earlier = Option.isSome(current) ? current : yield* readEscalation(clearedOf(ticket));
          const attempts = Option.match(earlier, { onNone: () => 0, onSome: (held) => held.attempts }) + 1;
          const escalation = new Escalation({ ticket, reason, attempts, worktree });
          const scratch = yield* writeScratch(encodeEscalation(escalation));
          yield* fs.makeDirectory(escalationsDir, { recursive: true }).pipe(
            Effect.andThen(fs.rename(scratch, escalationOf(ticket))),
            Effect.mapError(toLedgerError)
          );
          yield* removeRecord(clearedOf(ticket));
          return escalation;
        }).pipe(Effect.scoped);

      const clearEscalation = (ticket: TicketId) =>
        fs.makeDirectory(clearedDir, { recursive: true }).pipe(
          Effect.andThen(fs.rename(escalationOf(ticket), clearedOf(ticket))),
          Effect.catchIf(isNotFound, () => Effect.void),
          Effect.mapError(toLedgerError)
        );

      const escalations = (tickets: readonly TicketId[]) =>
        readMany(tickets, (ticket) => readEscalation(escalationOf(ticket)));

      // The record names the ticket; its presence is the fact.
      const recordDone = (ticket: TicketId) =>
        Effect.gen(function* () {
          const scratch = yield* writeScratch(encodeDone({ ticket }));
          yield* fs.makeDirectory(doneDir, { recursive: true }).pipe(
            Effect.andThen(fs.rename(scratch, doneOf(ticket))),
            Effect.mapError(toLedgerError)
          );
        }).pipe(Effect.scoped);

      const done = (tickets: readonly TicketId[]) =>
        Effect.forEach(tickets, (ticket) =>
          fs.exists(doneOf(ticket)).pipe(
            Effect.map((exists) => (exists ? [ticket] : [])),
            Effect.mapError(toLedgerError)
          )
        ).pipe(Effect.map((found) => new Set(found.flat())));

      return {
        claim,
        assignRunner,
        release,
        isStale,
        replaceStale,
        ticketsClaimedBy,
        read,
        escalate,
        clearEscalation,
        escalations,
        recordDone,
        done,
      };
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
