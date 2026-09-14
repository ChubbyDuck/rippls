import { ConfigProvider, Effect, Layer } from 'effect';

import { harnessConfigProvider } from '~/Core/Shared/Domain/HarnessConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';

import { loadHarnessFileConfig } from './load';

export const HarnessFileConfigLive = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* RepositoryRoot;
    const fileConfig = yield* loadHarnessFileConfig(root);
    return ConfigProvider.layer(harnessConfigProvider(fileConfig));
  })
);
