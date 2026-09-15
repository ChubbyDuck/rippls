import { Config, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from 'effect';
import { parse, stringify } from 'yaml';

import { TicketsDir } from '~/Core/Shared/Domain/EngineConfig';
import { Ticket, TicketFromInput } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId, parseTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketNotSaved } from '~/Core/Tickets/Domain/Exceptions/TicketNotSaved';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

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

const headToTicket = (text: string, fileId: number): Option.Option<Ticket> => {
  const fields = parseFrontMatter(text);
  if (fields === undefined || typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return Option.none();
  }
  const record = fields as { readonly [key: string]: unknown };
  return Schema.decodeUnknownOption(TicketFromInput)({
    ...record,
    id: toFolderId(fileId),
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
    ...(ticket.claimedBy !== undefined ? { claimedBy: ticket.claimedBy } : {}),
    kind: ticket.kind,
    hitl: ticket.hitl,
    body,
  });

const toFrontMatter = (ticket: Ticket) => ({
  id: toNativeNumber(ticket.id),
  title: ticket.title,
  project: ticket.project,
  status: ticket.status,
  kind: ticket.kind,
  hitl: ticket.hitl,
  blockedBy: ticket.blockedBy.map(toNativeNumber),
  blocks: ticket.blocks.map(toNativeNumber),
  ...(ticket.claimedBy !== undefined ? { claimedBy: ticket.claimedBy } : {}),
});

const matchesQuery =
  (query: TicketQuery) =>
  (ticket: Ticket): boolean => {
    if (query.id !== undefined && ticket.id !== query.id) {
      return false;
    }
    if (query.blockedBy !== undefined && !ticket.isBlockedBy(query.blockedBy)) {
      return false;
    }
    if (query.unblocked === true && ticket.blockedBy.length !== 0) {
      return false;
    }
    if (query.unclaimed === true && (ticket.claimedBy !== undefined || ticket.status === 'claiming')) {
      return false;
    }
    if (query.claimed === true && ticket.status !== 'claiming' && ticket.status !== 'claimed') {
      return false;
    }
    if (query.afk === true && ticket.hitl !== 'no') {
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

// TODO: we have a hard question of transactioning file processing...
export const TicketSourceFolderLive = Layer.effect(
  TicketSource,
  Effect.all({
    fs: FileSystem.FileSystem,
    path: Path.Path,
    dir: Config.schema(TicketsDir, 'ticketsDir'),
  }).pipe(
    Effect.map(({ fs, path, dir }) => {
      const readHead = (file: string): Effect.Effect<Option.Option<Ticket>> => {
        const fileId = idFromFilename(file);
        if (fileId === undefined) {
          return Effect.succeedNone;
        }
        return fs.stream(path.join(dir, file), { chunkSize: 4096 }).pipe(
          Stream.decodeText(),
          Stream.scan('', (accumulated, chunk) => accumulated + chunk),
          Stream.takeUntil(hasClosingDelimiter),
          Stream.runLast,
          Effect.map(Option.flatMap((text) => headToTicket(text, fileId))),
          Effect.catchCause(() => Effect.succeedNone)
        );
      };

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

      const getManyBy = (query: TicketQuery): Effect.Effect<readonly Ticket[]> =>
        fs.readDirectory(dir).pipe(
          Effect.map(sortByIdName(query)),
          Effect.flatMap((files) =>
            Stream.fromIterable(files).pipe(
              Stream.mapEffect(readHead, { concurrency: 1 }),
              Stream.filter(
                (option): option is Option.Some<Ticket> => Option.isSome(option) && matchesQuery(query)(option.value)
              ),
              Stream.map((option) => option.value),
              Stream.runCollect
            )
          ),
          Effect.catchCause(() => Effect.succeed<readonly Ticket[]>([]))
        );

      const save = (ticket: Ticket): Effect.Effect<void, TicketNotSaved> => {
        const block = `---\n${stringify(toFrontMatter(ticket))}---`;
        return Effect.gen(function* () {
          const files = yield* fs.readDirectory(dir).pipe(Effect.catchCause(() => Effect.succeed<string[]>([])));
          const nativeId = toNativeNumber(ticket.id);
          const basename = findFileForId(files, nativeId) ?? `${nativeId}.md`;
          const rootFile = path.join(dir, basename);
          const dest = ticket.status === 'done' ? path.join(dir, 'done', basename) : rootFile;
          if (ticket.status === 'done') {
            yield* fs.makeDirectory(path.join(dir, 'done'), { recursive: true });
          }
          const source = yield* fs.exists(rootFile).pipe(Effect.map((exists) => (exists ? rootFile : dest)));
          const next = yield* fs.exists(source).pipe(
            Effect.flatMap((exists) =>
              exists
                ? fs.readFileString(source).pipe(
                    Effect.map((content) =>
                      hasClosingDelimiter(content)
                        ? content.replace(FRONT_MATTER, () => block)
                        : `${block}\n\n${content}`
                    )
                  )
                : Effect.succeed(`${block}\n\n${ticket.body}`)
            )
          );
          yield* fs.writeFileString(dest, next);
          if (source !== dest) {
            yield* fs.remove(source);
          }
        }).pipe(Effect.mapError(() => new TicketNotSaved()));
      };

      const saveMany = (tickets: readonly Ticket[]): Effect.Effect<void, TicketNotSaved> =>
        Effect.forEach(tickets, save, { discard: true });

      return { getOneBy, getManyBy, save, saveMany };
    })
  )
);
