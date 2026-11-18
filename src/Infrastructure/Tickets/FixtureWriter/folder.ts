import { Effect, FileSystem, Layer, Path } from 'effect';
import { stringify } from 'yaml';

import { parseTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { FixtureNotWritten } from '~/Core/Tickets/Domain/Exceptions/FixtureNotWritten';
import { type Fixture, FixtureWriter } from '~/Core/Tickets/Ports/FixtureWriter';

const toNativeNumber = (id: TicketId): number => Number(parseTicketId(id).native);

const toFrontMatter = (ticket: Fixture) => ({
  id: toNativeNumber(ticket.id),
  title: ticket.title,
  project: ticket.project,
  status: ticket.status,
  kind: ticket.kind,
  hitl: ticket.hitl,
  blockedBy: ticket.blockedBy.map(toNativeNumber),
  blocks: ticket.blocks.map(toNativeNumber),
});

const toFileContent = (ticket: Fixture): string => `---\n${stringify(toFrontMatter(ticket))}---\n\n${ticket.body}`;

/**
 * Writes each fixture ticket to `<id>.md` in the tickets folder, or in its `done/`
 * subfolder when the ticket is done. A done ticket removes `<id>.md` from the tickets
 * folder. Other files of the same number, such as `<id>-slug.md`, stay untouched.
 */
export const fixtureWriterFolderLive = (ticketsDir: string) =>
  Layer.effect(
    FixtureWriter,
    Effect.all({ fs: FileSystem.FileSystem, path: Path.Path }).pipe(
      Effect.map(({ fs, path }) => {
        const doneDir = path.join(ticketsDir, 'done');

        const writeOne = (ticket: Fixture) =>
          Effect.gen(function* () {
            const basename = `${toNativeNumber(ticket.id)}.md`;
            const rootFile = path.join(ticketsDir, basename);
            if (ticket.status !== 'done') {
              return yield* fs.writeFileString(rootFile, toFileContent(ticket));
            }
            yield* fs.makeDirectory(doneDir, { recursive: true });
            yield* fs.writeFileString(path.join(doneDir, basename), toFileContent(ticket));
            yield* fs.remove(rootFile, { force: true });
          });

        const write = (tickets: readonly Fixture[]): Effect.Effect<void, FixtureNotWritten> =>
          Effect.forEach(tickets, writeOne, { discard: true }).pipe(
            Effect.mapError((cause) => new FixtureNotWritten({ cause }))
          );

        return { write };
      })
    )
  );
