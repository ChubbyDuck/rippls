import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Config, ConfigProvider, Effect, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { harnessFileConfig } from '~/config/config';
import {
  HarnessConfig,
  harnessConfigProvider,
  idleTimeoutConfig,
  pollIntervalConfig,
  resolveTicketSource,
  TicketSourceTag,
} from '~/Core/Shared/Domain/HarnessConfig';
import { RepositoryRoot } from '~/Core/Shared/Domain/RepositoryRoot';
import { RepositoryRootLive } from '~/Core/Tickets/Application/UseCases/RunHarness/repositoryRoot';
import { runHarness } from '~/Core/Tickets/Application/UseCases/RunHarness/runHarness';
import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { ConfiguredAgentsLive } from '~/Infrastructure/Shared/AgentRepository/configured';
import { makeTracingLayer } from '~/Infrastructure/Shared/Tracing/otlp';
import { StrategyRepositoryDefault } from '~/Infrastructure/Tickets/StrategyRepository/default';
import { liveTicketRepository } from '~/Infrastructure/Tickets/TicketRepository/fromSource';
import { WorktreeRepositoryLive } from '~/Infrastructure/Tickets/WorktreeRepository/sandcastle';

const TracingLive = makeTracingLayer(Option.fromNullishOr(harnessFileConfig.otlpTraceUrl));

const AppLive = Layer.mergeAll(
  StrategyRepositoryDefault,
  ConfiguredAgentsLive,
  Layer.unwrap(RepositoryRoot.pipe(Effect.map(WorktreeRepositoryLive)))
).pipe(
  Layer.provideMerge(RepositoryRootLive),
  Layer.provide(ConfigProvider.layer(harnessConfigProvider(harnessFileConfig)))
);

const Concurrency = Schema.Int.check(Schema.isGreaterThan(0));

const command = Command.make(
  'rippls',
  {
    source: Flag.choice('source', TicketSourceTag.literals).pipe(Flag.optional),
    project: Flag.string('project').pipe(Flag.withSchema(Project), Flag.optional),
    queue: Flag.integer('queue').pipe(Flag.optional),
    concurrency: Flag.integer('concurrency').pipe(Flag.withSchema(Concurrency), Flag.withDefault(1)),
    idleTimeout: Flag.string('idle-timeout').pipe(
      Flag.withSchema(Schema.DurationFromString),
      Flag.withFallbackConfig(idleTimeoutConfig)
    ),
    pollInterval: Flag.string('poll-interval').pipe(
      Flag.withSchema(Schema.DurationFromString),
      Flag.withFallbackConfig(pollIntervalConfig)
    ),
  },
  ({ source, project, queue, concurrency, idleTimeout, pollInterval }) =>
    Effect.gen(function* () {
      const config = yield* HarnessConfig;
      const resolved = yield* resolveTicketSource(config.source, Option.getOrUndefined(source));
      return yield* runHarness({
        project: Option.getOrUndefined(project),
        queue: Option.getOrUndefined(queue),
        concurrency,
        idleTimeout,
        pollInterval,
      }).pipe(Effect.provide(liveTicketRepository(resolved)));
    })
);

export const program = Command.run(command, { version: '0.0.1' }).pipe(
  Effect.provide(Layer.mergeAll(AppLive, TracingLive).pipe(Layer.provideMerge(NodeServices.layer)))
);

const describeError = (error: unknown) => (error instanceof Config.ConfigError ? error.cause.message : error);

if (import.meta.main) {
  program.pipe(
    Effect.tapError((error) => Effect.logError(describeError(error))),
    NodeRuntime.runMain({ disableErrorReporting: true })
  );
}
