import { Config, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { parse } from 'yaml';

import { TicketsDir } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { Ticket, TicketFromInput } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId, parseTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { type AfterMerge, TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import type { Worktree } from '~/Core/Tickets/Ports/WorktreeManager';

const FOLDER_SOURCE = 'folder';

const toFolderId = (native: number | string): TicketId => formatTicketId(FOLDER_SOURCE, String(native));

const toNativeNumber = (id: TicketId): number => Number(parseTicketId(id).native);

const namespaceIds = (value: unknown): unknown =>
  Array.isArray(value) ? value.map((item) => (typeof item === 'number' ? toFolderId(item) : item)) : value;

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const ID_FILE = /^(\d+).*\.md$/;

const idFromFilename = (file: string): number | undefined => {
  const match = ID_FILE.exec(file);
  return match === null ? undefined : Number(match[1]);
};

const findFileForId = (files: readonly string[], id: number): string | undefined =>
  files.find((file) => idFromFilename(file) === id);

const hasClosingDelimiter = (text: string): boolean => FRONT_MATTER.test(text);

const parseFrontMatter = (text: string): unknown => {
  const match = FRONT_MATTER.exec(text);
  if (match === null) {
    return undefined;
  }
  try {
    return parse(match[1]);
  } catch {
    return undefined;
  }
};

// An earlier Engine wrote its Claim into the ticket. The Claim lives in the Ledger
// now, so a claim status reads as the readiness it replaced and `claimedBy` is
// ignored.
const CLAIM_STATUSES = new Set(['claiming', 'claimed']);

const withoutClaim = (status: unknown): unknown =>
  typeof status === 'string' && CLAIM_STATUSES.has(status) ? 'ready-for-agent' : status;

// A ticket in `done/` is done, whatever its front matter says.
const headToTicket = (text: string, fileId: number, inDone: boolean): Option.Option<Ticket> => {
  const fields = parseFrontMatter(text);
  if (fields === undefined || typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return Option.none();
  }
  const record = fields as { readonly [key: string]: unknown };
  return Schema.decodeUnknownOption(TicketFromInput)({
    ...record,
    id: toFolderId(fileId),
    status: inDone ? 'done' : withoutClaim(record.status),
    blockedBy: namespaceIds(record.blockedBy),
    blocks: namespaceIds(record.blocks),
    body: '',
  });
};

const bodyAfterFrontMatter = (text: string): string => {
  const match = FRONT_MATTER.exec(text);
  return (match === null ? text : text.slice(match[0].length)).replace(/^(?:\r?\n)+/, '');
};

const withBody = (ticket: Ticket, body: string): Ticket =>
  new Ticket({
    id: ticket.id,
    title: ticket.title,
    project: ticket.project,
    status: ticket.status,
    blockedBy: ticket.blockedBy,
    blocks: ticket.blocks,
    kind: ticket.kind,
    hitl: ticket.hitl,
    body,
  });

/** The fixed message of the commit that moves a ticket into `done/` on its ticket branch. */
export const doneMoveMessage = (ticket: TicketId): string => `chore: move ticket ${ticket} to done`;

const matchesQuery =
  (query: TicketQuery) =>
  (ticket: Ticket): boolean => {
    if (query.id !== undefined && ticket.id !== query.id) {
      return false;
    }
    if (query.blockedBy !== undefined && !ticket.isBlockedBy(query.blockedBy)) {
      return false;
    }
    if (query.project !== undefined && ticket.project !== query.project) {
      return false;
    }
    return true;
  };

const sortByIdName =
  (query: TicketQuery) =>
  (files: readonly string[]): string[] => {
    const withId = files.flatMap((file) => {
      const id = idFromFilename(file);
      return id === undefined ? [] : [{ file, id }];
    });
    const descending = query.sort === 'DESC';
    withId.sort((left, right) => (descending ? right.id - left.id : left.id - right.id));
    return withId.map((entry) => entry.file);
  };

export const TicketSourceFolderLive = Layer.effect(
  TicketSource,
  Effect.all({
    fs: FileSystem.FileSystem,
    path: Path.Path,
    spawner: ChildProcessSpawner.ChildProcessSpawner,
    root: RepositoryRoot,
    dir: Config.schema(TicketsDir, 'ticketsDir'),
  }).pipe(
    Effect.map(({ fs, path, spawner, root, dir }) => {
      const doneDir = path.join(dir, 'done');

      const readHeadIn = (folder: string, inDone: boolean) => (file: string): Effect.Effect<Option.Option<Ticket>> => {
        const fileId = idFromFilename(file);
        if (fileId === undefined) {
          return Effect.succeedNone;
        }
        return fs.stream(path.join(folder, file), { chunkSize: 4096 }).pipe(
          Stream.decodeText(),
          Stream.scan('', (accumulated, chunk) => accumulated + chunk),
          Stream.takeUntil(hasClosingDelimiter),
          Stream.runLast,
          Effect.map(Option.flatMap((text) => headToTicket(text, fileId, inDone))),
          Effect.catchCause(() => Effect.succeedNone)
        );
      };

      const readHead = readHeadIn(dir, false);
      const readDoneHead = readHeadIn(doneDir, true);

      const getOneBy = (query: TicketQuery): Effect.Effect<Ticket, TicketNotFound> =>
        fs.readDirectory(dir).pipe(
          Effect.map(sortByIdName(query)),
          Effect.flatMap((files) =>
            Stream.fromIterable(files).pipe(
              Stream.mapEffect(
                (file) =>
                  readHead(file).pipe(Effect.map((option) => Option.map(option, (ticket) => ({ file, ticket })))),
                { concurrency: 1 }
              ),
              Stream.filter(
                (option): option is Option.Some<{ file: string; ticket: Ticket }> =>
                  Option.isSome(option) && matchesQuery(query)(option.value.ticket)
              ),
              Stream.map((option) => option.value),
              Stream.runHead
            )
          ),
          Effect.catchCause(() => Effect.succeed(Option.none<{ file: string; ticket: Ticket }>())),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new TicketNotFound()),
              onSome: ({ file, ticket }) =>
                fs.readFileString(path.join(dir, file)).pipe(
                  Effect.map((text) => withBody(ticket, bodyAfterFrontMatter(text))),
                  Effect.catchCause(() => Effect.succeed(ticket))
                ),
            })
          )
        );

      const readManyIn = (
        folder: string,
        read: (file: string) => Effect.Effect<Option.Option<Ticket>>,
        query: TicketQuery
      ): Effect.Effect<readonly Ticket[]> =>
        fs.readDirectory(folder).pipe(
          Effect.map(sortByIdName(query)),
          Effect.flatMap((files) =>
            Stream.fromIterable(files).pipe(
              Stream.mapEffect(read, { concurrency: 1 }),
              Stream.filter(
                (option): option is Option.Some<Ticket> => Option.isSome(option) && matchesQuery(query)(option.value)
              ),
              Stream.map((option) => option.value),
              Stream.runCollect
            )
          ),
          Effect.catchCause(() => Effect.succeed<readonly Ticket[]>([]))
        );

      // The tickets of the tickets folder in processing order, then those of `done/`,
      // so the core eligibility rule can tell which blockers are done.
      const getManyBy = (query: TicketQuery): Effect.Effect<readonly Ticket[]> =>
        Effect.all([readManyIn(dir, readHead, query), readManyIn(doneDir, readDoneHead, query)]).pipe(
          Effect.map(([current, done]) => [...current, ...done])
        );

      // The folder Source keeps no trace of a Claim or an escalation: the Ledger holds them.
      const report = (_ticket: TicketId, _event: Exclude<TicketEvent, 'done'>): Effect.Effect<void> => Effect.void;

      const notReported = (ticket: TicketId) => () => new TicketEventNotReported({ ticketId: ticket, event: 'done' });

      // Runs Git and fails when it exits with a code other than zero.
      const git = (args: readonly string[], cwd: string) =>
        spawner.exitCode(ChildProcess.make('git', args, { cwd })).pipe(
          Effect.filterOrFail(
            (code) => code === 0,
            (code) => `git ${args.join(' ')} exited with ${code}`
          )
        );

      // Whether Git tracks the file in the worktree.
      const isTracked = (worktree: string, file: string) =>
        spawner
          .exitCode(ChildProcess.make('git', ['ls-files', '--error-unmatch', '--', file], { cwd: worktree }))
          .pipe(Effect.map((code) => code === 0));

      // The name of the ticket's file in the tickets folder or in `done/`.
      const fileOf = (ticket: TicketId) =>
        Effect.gen(function* () {
          const native = toNativeNumber(ticket);
          const open = findFileForId(yield* fs.readDirectory(dir), native);
          if (open !== undefined) {
            return Option.some({ name: open, inDone: false });
          }
          const done = yield* fs.readDirectory(doneDir).pipe(Effect.catchCause(() => Effect.succeed<string[]>([])));
          return Option.map(Option.fromNullishOr(findFileForId(done, native)), (name) => ({ name, inDone: true }));
        });

      // The move into `done/` in the tickets folder, once the merge succeeded. It
      // never changes the file's content, and a file already in `done/` stays.
      const moveInTicketsFolder = (ticket: TicketId, name: string): AfterMerge =>
        Effect.gen(function* () {
          const from = path.join(dir, name);
          const to = path.join(doneDir, name);
          if ((yield* fs.exists(to)) || !(yield* fs.exists(from))) {
            return;
          }
          yield* fs.makeDirectory(doneDir, { recursive: true });
          yield* fs.rename(from, to);
        }).pipe(Effect.mapError(notReported(ticket)));

      // The move into `done/` on the ticket branch, committed with a fixed message
      // so it lands with the work. Commit hooks run. When the commit fails, the
      // move is undone, so the Ticket Worktree is left as it was.
      const commitMoveInWorktree = (ticket: TicketId, worktree: string, from: string, to: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.join(worktree, path.dirname(to)), { recursive: true });
          yield* git(['mv', '--', from, to], worktree);
          yield* git(['commit', '--quiet', '-m', doneMoveMessage(ticket), '--', from, to], worktree).pipe(
            Effect.tapError(() => git(['mv', '--', to, from], worktree).pipe(Effect.ignore))
          );
        });

      // Done moves the file into `done/`. A file that the Ticket Worktree tracks is
      // moved there and the move is committed on the ticket branch before the
      // merge, so the merge moves the copy in the Repository Root, or the Ledger
      // covers it for a Project ticket. Any other file, as in a tickets folder
      // that Git ignores, waits for the merge: its name is returned. A file
      // already in `done/` stays where it is.
      const moveBeforeMerge = (ticket: TicketId, worktree: Worktree) =>
        Effect.gen(function* () {
          const file = yield* fileOf(ticket);
          if (Option.isNone(file) || file.value.inDone) {
            return Option.none<string>();
          }
          const { name } = file.value;
          const inRepository = path.relative(root, dir);
          if (inRepository.startsWith('..') || path.isAbsolute(inRepository)) {
            return Option.some(name);
          }
          const from = path.join(inRepository, name);
          const to = path.join(inRepository, 'done', name);
          if (yield* isTracked(worktree.path, to)) {
            return Option.none<string>();
          }
          if (yield* isTracked(worktree.path, from)) {
            yield* commitMoveInWorktree(ticket, worktree.path, from, to);
            return Option.none<string>();
          }
          return Option.some(name);
        });

      const reportDone = (ticket: TicketId, worktree: Worktree): Effect.Effect<AfterMerge, TicketEventNotReported> =>
        moveBeforeMerge(ticket, worktree).pipe(
          Effect.map(
            Option.match({
              onNone: (): AfterMerge => Effect.void,
              onSome: (name) => moveInTicketsFolder(ticket, name),
            })
          ),
          Effect.mapError(notReported(ticket))
        );

      return { getOneBy, getManyBy, report, reportDone };
    })
  )
);
