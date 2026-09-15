import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Layer, Path } from 'effect';
import { Command } from 'effect/unstable/cli';

import { EngineFileConfigLive } from '~/config/layer';
import { engineConfig, resolveTicketSource } from '~/Core/Shared/Domain/EngineConfig';
import { RepositoryRootLive } from '~/Core/Tickets/Application/UseCases/RunEngine/repositoryRoot';

const ID_FILE = /^\d+.*\.md$/;

const AppLive = EngineFileConfigLive.pipe(Layer.provideMerge(RepositoryRootLive));

const command = Command.make('clean', {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* engineConfig;
    const source = yield* resolveTicketSource(config.source, 'folder');
    const files = yield* fs.readDirectory(source.ticketsDir);
    const tickets = files.filter((file) => ID_FILE.test(file));
    yield* Effect.forEach(tickets, (file) => fs.remove(path.join(source.ticketsDir, file)));
    yield* Console.log(`Removed ${tickets.length} ticket file(s)`);
  })
);

export const program = Command.run(command, { version: '0.0.1' }).pipe(
  Effect.provide(AppLive.pipe(Layer.provideMerge(NodeServices.layer)))
);

if (import.meta.main) {
  program.pipe(Effect.tapError((error) => Effect.logError(error)), NodeRuntime.runMain({ disableErrorReporting: true }));
}
