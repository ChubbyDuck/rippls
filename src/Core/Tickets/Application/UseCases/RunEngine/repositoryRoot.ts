import { Effect, Layer } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { RepositoryRootNotFound } from '~/Core/Tickets/Domain/Exceptions/RepositoryRootNotFound';

const repositoryRoot = ChildProcessSpawner.ChildProcessSpawner.pipe(
  Effect.flatMap((spawner) =>
    spawner.string(ChildProcess.make('git', ['rev-parse', '--show-toplevel']))
  ),
  Effect.map((output) => output.trim()),
  Effect.mapError(() => new RepositoryRootNotFound())
);

export const RepositoryRootLive = Layer.effect(RepositoryRoot, repositoryRoot);
