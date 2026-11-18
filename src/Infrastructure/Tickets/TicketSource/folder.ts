import { Config, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { parse } from 'yaml';

import { defaultKindConfig, TicketsDir } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import {
  type Ticket,
  type TicketFallbacks,
  TicketHints,
  ticketFromHints,
} from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { fallbackHitl, Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { Marker } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Marker';
import { formatTicketId, parseTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { ReportedEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { type AfterMerge, TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import type { Worktree } from '~/Core/Tickets/Ports/WorktreeManager';

const FOLDER_SOURCE = 'folder';

const DONE = 'done';

const toFolderId = (native: string): TicketId => formatTicketId(FOLDER_SOURCE, native);

// The identity of the ticket with a number in a folder below the tickets folder.
// The folder is its path with `/` between segments, and empty for the tickets
// folder itself, so a ticket there keeps the identity `folder:<number>`.
const ticketIdIn = (folder: string, number: number): TicketId =>
  toFolderId(folder === '' ? String(number) : `${folder}/${number}`);

// The folder and the number of a folder identity. A native that ends in no
// number, as for a blocker that cannot be resolved, has no number.
const locationOf = (id: TicketId): { readonly folder: string; readonly number: number } => {
  const { native } = parseTicketId(id);
  const separator = native.lastIndexOf('/');
  return {
    folder: separator === -1 ? '' : native.slice(0, separator),
    number: /^\d+$/.test(native.slice(separator + 1)) ? Number(native.slice(separator + 1)) : Number.NaN,
  };
};

// The numbers of a `blockedBy` field name tickets of the same folder.
const namespaceIds = (value: unknown, folder: string): unknown =>
  Array.isArray(value) ? value.map((item) => (typeof item === 'number' ? ticketIdIn(folder, item) : item)) : value;

const ID_FILE = /^(\d+).*\.md$/;

const idFromFilename = (file: string): number | undefined => {
  const match = ID_FILE.exec(file);
  return match === null ? undefined : Number(match[1]);
};

const findFileForId = (files: readonly string[], id: number): string | undefined =>
  files.find((file) => idFromFilename(file) === id);

/**
 * A ticket file found below the tickets folder: its name, the folders of its path,
 * and its folder, which is that path without `done` segments. A file in a `done/`
 * is done; its folder is the one it had while open.
 */
type TicketFile = {
  readonly name: string;
  readonly number: number;
  readonly path: readonly string[];
  readonly folder: readonly string[];
  readonly inDone: boolean;
};

const ticketFileOf = (relative: readonly string[]): TicketFile | undefined => {
  const name = relative.at(-1);
  const number = name === undefined ? undefined : idFromFilename(name);
  if (name === undefined || number === undefined) {
    return undefined;
  }
  const path = relative.slice(0, -1);
  return {
    name,
    number,
    path,
    folder: path.filter((segment) => segment !== DONE),
    inDone: path.includes(DONE),
  };
};

// Folders in the order of their paths, segment by segment, so the tickets folder
// itself comes first and a folder comes before the folders below it.
const compareFolders = (left: readonly string[], right: readonly string[]): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const [a, b] = [left[index]!, right[index]!];
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return left.length - right.length;
};

const OPENING_DELIMITER = /^---[ \t]*\r?\n/;
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?=\r?\n|$)/;

type FrontMatterAndBody = { readonly fields: { readonly [key: string]: unknown }; readonly body: string };

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The front matter and the body of a ticket file. A file without front matter is
// all body. Front matter without a closing delimiter, or that does not parse to a
// mapping, cannot be read.
const splitFrontMatter = (text: string): Option.Option<FrontMatterAndBody> => {
  if (!OPENING_DELIMITER.test(text)) {
    return Option.some({ fields: {}, body: text });
  }
  const match = FRONT_MATTER.exec(text);
  if (match === null) {
    return Option.none();
  }
  let fields: unknown;
  try {
    fields = parse(match[1] ?? '');
  } catch {
    return Option.none();
  }
  if (fields === null || fields === undefined) {
    fields = {};
  }
  if (!isRecord(fields)) {
    return Option.none();
  }
  return Option.some({ fields, body: text.slice(match[0].length).replace(/^(?:\r?\n)+/, '') });
};

const FENCE = /^\s*(?:```|~~~)/;

// The lines of a body outside fenced code blocks.
const proseLines = (body: string): readonly string[] => {
  let fenced = false;
  return body.split(/\r?\n/).filter((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
};

// The match of the first prose line of the body that the pattern matches.
const firstProseMatch = (body: string, pattern: RegExp): RegExpExecArray | undefined => {
  for (const line of proseLines(body)) {
    const match = pattern.exec(line);
    if (match !== null) {
      return match;
    }
  }
  return undefined;
};

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
const LEADING_TICKET_NUMBER = /^\d+\s*[-–—:.)](?:\s+|$)/;

// The first heading of the body, without a leading ticket number and separator,
// such as the `10 — ` of `# 10 — A ticket`.
const headingTitle = (body: string): string | undefined => {
  const match = firstProseMatch(body, HEADING);
  if (match === undefined) {
    return undefined;
  }
  const title = (match[1] ?? '').replace(LEADING_TICKET_NUMBER, '').trim();
  return title === '' ? undefined : title;
};

// The filename without its numeric prefix, the separator after it, and the
// extension. A name that is only a number stays whole, so the Title is never empty.
const filenameTitle = (file: string): string => {
  const stem = file.replace(/\.md$/, '');
  const title = stem.replace(/^\d+[-_.\s]*/, '').trim();
  return title === '' ? stem : title;
};

const STATUS_LINE = /^\s*(?:[-*+]\s+)?[*_]*status[*_]*\s*:[*_]*\s*`?([\w-]+)`?/i;

// The Marker a value names, in any case.
const markerOf = (value: unknown): Marker | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Marker)(typeof value === 'string' ? value.toLowerCase() : value));

// The Marker of the first "Status" line of the body, such as `**Status:** ready-for-agent`.
const markerInBody = (body: string): Marker | undefined => {
  const match = firstProseMatch(body, STATUS_LINE);
  return match === undefined ? undefined : markerOf(match[1]);
};

const BLOCKED_BY_LINE = /^\s*(?:[-*+]\s+)?[*_]*blocked by[*_]*\s*:[*_]*\s*(.*)$/i;
const BLOCKED_BY_NONE = /^none\b/i;
const ITEM_NUMBER = /^(\d+)/;

// The items of a "Blocked by" line, split at the commas outside parentheses, so
// that a title in parentheses stays with its item.
const blockedByItems = (line: string): readonly string[] => {
  const items: string[] = [];
  let depth = 0;
  let item = '';
  for (const char of line) {
    if (char === ',' && depth === 0) {
      items.push(item);
      item = '';
      continue;
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    }
    item += char;
  }
  items.push(item);
  return items.map((each) => each.trim()).filter((each) => each !== '');
};

// The blocker an item names: the ticket of the same folder with its leading number,
// whatever text follows. An item without a leading number keeps its text, so it
// resolves to no ticket and blocks.
const blockerOf = (item: string, folder: string): TicketId => {
  const match = ITEM_NUMBER.exec(item);
  return match === null ? toFolderId(item) : ticketIdIn(folder, Number(match[1]));
};

// The blockers of the first "Blocked by" line of the body, such as
// `**Blocked by:** 02 (A title), 10`. "None", with or without a remark, names none.
// A line that names nothing, as when its items follow on the next lines, cannot be
// resolved: the line itself is its one blocker, so the ticket stays blocked.
const blockersInBody = (body: string, folder: string): readonly TicketId[] | undefined => {
  const match = firstProseMatch(body, BLOCKED_BY_LINE);
  if (match === undefined) {
    return undefined;
  }
  const value = (match[1] ?? '').trim();
  if (BLOCKED_BY_NONE.test(value)) {
    return [];
  }
  const items = blockedByItems(value);
  return items.length === 0 ? [toFolderId(match[0].trim())] : items.map((item) => blockerOf(item, folder));
};

// A key with no value states nothing, like a missing key.
const emptyAsMissing = (value: unknown): unknown => (value === null ? undefined : value);

/**
 * The Ticket a file reads as, or none when it is unreadable. A Ticket needs an
 * identity, from its folder and the numeric filename prefix, and text. Every
 * other value is a hint: the Title comes from the `title` field, the first
 * heading, or the filename; the Project from the `project` field or the first
 * folder below the tickets folder; the Marker from a `status` field or a "Status"
 * line; the blockers, numbers of tickets in the same folder, from a `blockedBy`
 * field or a "Blocked by" line. A `status` value is read only as a Marker;
 * `blocks`, `claimedBy`, and unknown keys are ignored. An invalid value for a
 * known hint makes the file unreadable. A ticket in a `done/` is done.
 */
const fileToTicket = (text: string, file: TicketFile, fallbacks: TicketFallbacks): Option.Option<Ticket> => {
  const folder = file.folder.join('/');
  return Option.flatMap(splitFrontMatter(text), ({ fields, body }) =>
    Schema.decodeUnknownOption(TicketHints)({
      id: ticketIdIn(folder, file.number),
      title: emptyAsMissing(fields.title) ?? headingTitle(body) ?? filenameTitle(file.name),
      body,
      project: emptyAsMissing(fields.project) ?? file.folder[0],
      blockedBy: namespaceIds(emptyAsMissing(fields.blockedBy), folder) ?? blockersInBody(body, folder),
      kind: emptyAsMissing(fields.kind),
      hitl: emptyAsMissing(fields.hitl),
      marker: markerOf(fields.status) ?? markerInBody(body),
      doneInSource: file.inDone,
    }).pipe(Option.map((hints) => ticketFromHints(hints, fallbacks)))
  );
};

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

// The processing order: by folder, then by number, lowest first. A descending
// sort reverses it.
const sortByFolderAndNumber =
  (query: TicketQuery) =>
  (files: readonly TicketFile[]): TicketFile[] => {
    const direction = query.sort === 'DESC' ? -1 : 1;
    return [...files].sort(
      (left, right) => direction * (compareFolders(left.folder, right.folder) || left.number - right.number)
    );
  };

export const TicketSourceFolderLive = Layer.effect(
  TicketSource,
  Effect.all({
    fs: FileSystem.FileSystem,
    path: Path.Path,
    spawner: ChildProcessSpawner.ChildProcessSpawner,
    root: RepositoryRoot,
    dir: Config.schema(TicketsDir, 'ticketsDir'),
    kind: defaultKindConfig,
    hitl: Config.schema(Hitl, 'defaultHitl').pipe(Config.withDefault(fallbackHitl)),
  }).pipe(
    Effect.map(({ fs, path, spawner, root, dir, kind, hitl }) => {
      const fallbacks: TicketFallbacks = { kind, hitl };

      const readTicket = (file: TicketFile): Effect.Effect<Option.Option<Ticket>> =>
        fs.readFileString(path.join(dir, ...file.path, file.name)).pipe(
          Effect.map((text) => fileToTicket(text, file, fallbacks)),
          Effect.catchCause(() => Effect.succeedNone)
        );

      // The ticket files below the tickets folder, at any depth, open or done.
      const ticketFiles = fs
        .readDirectory(dir, { recursive: true })
        .pipe(Effect.map((entries) => entries.flatMap((entry) => ticketFileOf(entry.split(path.sep)) ?? [])));

      // The readable open or done tickets that match the query, in processing order.
      const ticketsIn = (inDone: boolean, query: TicketQuery): Stream.Stream<Ticket> =>
        Stream.fromEffect(
          ticketFiles.pipe(
            Effect.map((files) => sortByFolderAndNumber(query)(files.filter((file) => file.inDone === inDone)))
          )
        ).pipe(
          Stream.flatMap(Stream.fromIterable),
          Stream.mapEffect(readTicket, { concurrency: 1 }),
          Stream.filter((option): option is Option.Some<Ticket> => Option.isSome(option) && matchesQuery(query)(option.value)),
          Stream.map((option) => option.value),
          Stream.catchCause(() => Stream.empty)
        );

      const getOneBy = (query: TicketQuery): Effect.Effect<Ticket, TicketNotFound> =>
        ticketsIn(false, query).pipe(
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new TicketNotFound()),
              onSome: Effect.succeed,
            })
          )
        );

      // The open tickets in processing order, then those of the `done/` folders, so
      // the core eligibility rule can tell which blockers are done.
      const getManyBy = (query: TicketQuery): Effect.Effect<readonly Ticket[]> =>
        Effect.all([Stream.runCollect(ticketsIn(false, query)), Stream.runCollect(ticketsIn(true, query))]).pipe(
          Effect.map(([current, done]) => [...current, ...done])
        );

      // The folder Source keeps no trace of a Claim or an escalation: the Ledger holds them.
      const report = (_ticket: TicketId, _event: ReportedEvent): Effect.Effect<void> => Effect.void;

      const notReported = (ticket: TicketId) => () => new TicketEventNotReported({ ticketId: ticket, event: 'done' });

      const gitExit = (args: readonly string[], cwd: string) => spawner.exitCode(ChildProcess.make('git', args, { cwd }));

      // Runs Git and fails when it exits with a code other than zero.
      const git = (args: readonly string[], cwd: string) =>
        gitExit(args, cwd).pipe(
          Effect.filterOrFail(
            (code) => code === 0,
            (code) => `git ${args.join(' ')} exited with ${code}`
          )
        );

      // Whether Git tracks the file in the worktree.
      const isTracked = (worktree: string, file: string) =>
        gitExit(['ls-files', '--error-unmatch', '--', file], worktree).pipe(Effect.map((code) => code === 0));

      // The ticket's file in its folder or in the `done/` of that folder, with the
      // path of its folder below the tickets folder.
      const fileOf = (ticket: TicketId) =>
        Effect.gen(function* () {
          const { folder, number } = locationOf(ticket);
          const folderPath = folder === '' ? '' : path.join(...folder.split('/'));
          const open = findFileForId(yield* fs.readDirectory(path.join(dir, folderPath)), number);
          if (open !== undefined) {
            return Option.some({ folder: folderPath, name: open, inDone: false });
          }
          const done = yield* fs
            .readDirectory(path.join(dir, folderPath, DONE))
            .pipe(Effect.catchCause(() => Effect.succeed<string[]>([])));
          return Option.map(Option.fromNullishOr(findFileForId(done, number)), (name) => ({
            folder: folderPath,
            name,
            inDone: true,
          }));
        });

      // The move into the `done/` of the ticket's folder, once the merge succeeded.
      // It never changes the file's content, and a file already in `done/` stays.
      const moveInTicketsFolder = (ticket: TicketId, folder: string, name: string): AfterMerge =>
        Effect.gen(function* () {
          const doneDir = path.join(dir, folder, DONE);
          const from = path.join(dir, folder, name);
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

      // Done moves the file into the `done/` of its folder. A file that the Ticket
      // Worktree tracks is moved there and the move is committed on the ticket
      // branch before the merge, so the merge moves the copy in the Repository
      // Root, or the Ledger covers it for a Project ticket. Any other file, as in a
      // tickets folder that Git ignores, waits for the merge: its folder and name
      // are returned. A file already in `done/` stays where it is.
      const moveBeforeMerge = (ticket: TicketId, worktree: Worktree) =>
        Effect.gen(function* () {
          const file = yield* fileOf(ticket);
          if (Option.isNone(file) || file.value.inDone) {
            return Option.none<{ folder: string; name: string }>();
          }
          const { folder, name } = file.value;
          const inRepository = path.relative(root, dir);
          if (inRepository === '..' || inRepository.startsWith(`..${path.sep}`) || path.isAbsolute(inRepository)) {
            return Option.some({ folder, name });
          }
          const from = path.join(inRepository, folder, name);
          const to = path.join(inRepository, folder, DONE, name);
          if (yield* isTracked(worktree.path, to)) {
            return Option.none<{ folder: string; name: string }>();
          }
          if (yield* isTracked(worktree.path, from)) {
            yield* commitMoveInWorktree(ticket, worktree.path, from, to);
            return Option.none<{ folder: string; name: string }>();
          }
          return Option.some({ folder, name });
        });

      const reportDone = (ticket: TicketId, worktree: Worktree): Effect.Effect<AfterMerge, TicketEventNotReported> =>
        moveBeforeMerge(ticket, worktree).pipe(
          Effect.map(
            Option.match({
              onNone: (): AfterMerge => Effect.void,
              onSome: ({ folder, name }) => moveInTicketsFolder(ticket, folder, name),
            })
          ),
          Effect.mapError(notReported(ticket))
        );

      return { getOneBy, getManyBy, report, reportDone };
    })
  )
);
