import { Effect, FileSystem, Layer, Option, Path, type PlatformError, Schema } from 'effect';
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
 * ticket has a record in the `done` folder. The `replacing` folder has a folder per
 * ticket, which holds the new Claim of the one caller that is replacing its Stale
 * Claim.
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
      const replacingOf = (ticket: TicketId) => path.join(replacingDir, encodeURIComponent(ticket));
      const claimOf = (ticket: TicketId, engine: EngineId) =>
        Claim.make({ ticket, engine, process: holder.process, host: holder.host });

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
        const made = claimOf(ticket, engine);
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

      // The new Claim of a replace, in a folder of its own that is ready to be moved
      // to the ticket's name in the `replacing` folder. The file is named after its
      // scratch folder, so no other caller ever has a file of that name.
      const writeEntry = (content: string) =>
        Effect.gen(function* () {
          const scratch = yield* fs.makeTempDirectoryScoped({ directory: dir, prefix: '.scratch-' });
          const folder = path.join(scratch, 'replacing');
          const name = `${path.basename(scratch)}${RECORD_SUFFIX}`;
          yield* fs.makeDirectory(folder);
          yield* fs.writeFileString(path.join(folder, name), content);
          yield* fs.makeDirectory(replacingDir, { recursive: true });
          return { folder, name };
        }).pipe(Effect.mapError(toLedgerError));

      const entriesOf = (replacing: string) =>
        fs.readDirectory(replacing).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed<string[]>([])),
          Effect.mapError(toLedgerError)
        );

      // A caller enters the replace of a ticket by moving the folder with its new
      // Claim to the ticket's name. The move succeeds only when no folder with a
      // Claim is there, so only one caller is in at a time. Whether this caller is in
      // is returned; a move that fails for another reason fails.
      const enter = (folder: string, replacing: string) =>
        fs.rename(folder, replacing).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            entriesOf(replacing).pipe(
              Effect.flatMap((entries) => (entries.length > 0 ? Effect.succeed(false) : Effect.fail(toLedgerError(error))))
            )
          )
        );

      // The new Claim of a caller whose process no longer runs is stale: its replace
      // stopped. It is removed by its own name, so the Claim of a caller that runs
      // is never removed, and so is a file that cannot be read. Whether no caller
      // that runs is left in the replace is returned.
      const removeStopped = (replacing: string) =>
        Effect.gen(function* () {
          const stopped = yield* Effect.forEach(yield* entriesOf(replacing), (name) =>
            Effect.gen(function* () {
              const entry = path.join(replacing, name);
              const left = yield* readRecord(entry);
              if (Option.isSome(left) && !(yield* isStale(left.value))) {
                return false;
              }
              yield* removeRecord(entry);
              return true;
            })
          );
          return stopped.every((removed) => removed);
        });

      // A Stale Claim becomes the new Claim in one write: a rename of the new record
      // onto the stale one, so the ticket's record is always one of the two. A rename
      // does not tell which record it replaced, so only one caller at a time may make
      // it: the one that is in the replace of the ticket. Once in, it reads the record
      // again, since another caller may have replaced the Stale Claim before it. It
      // leaves the replace when it is done, whatever the outcome. A caller whose
      // process stops stays in, and the next caller removes it.
      const replaceStale = (stale: Claim, engine: EngineId) =>
        Effect.gen(function* () {
          const record = recordOf(stale.ticket);
          const replacing = replacingOf(stale.ticket);
          const holdsStale = readRecord(record).pipe(Effect.map(Option.exists((held) => held.isSameClaim(stale))));
          if (!(yield* holdsStale)) {
            return false;
          }
          const made = encodeClaim(claimOf(stale.ticket, engine));
          const scratch = yield* writeScratch(made);
          const { folder, name } = yield* writeEntry(made);
          const write = Effect.gen(function* () {
            if (!(yield* holdsStale)) {
              return false;
            }
            yield* fs.rename(scratch, record).pipe(Effect.mapError(toLedgerError));
            return true;
          });
          return yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
              return (
                (yield* enter(folder, replacing)) ||
                ((yield* removeStopped(replacing)) && (yield* enter(folder, replacing)))
              );
            }),
            (entered) => (entered ? write : Effect.succeed(false)),
            (entered) => (entered ? Effect.ignore(removeRecord(path.join(replacing, name))) : Effect.void)
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
          const escalation = Escalation.make({ ticket, reason, attempts, worktree });
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
