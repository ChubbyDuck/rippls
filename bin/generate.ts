import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Config, ConfigProvider, Console, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { harnessFileConfig } from '~/config/config';
import { harnessConfig, harnessConfigProvider, resolveTicketSource } from '~/Core/Shared/Domain/HarnessConfig';
import { generateTickets } from '~/Core/Tickets/Application/UseCases/Generate/generate';
import { Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { TicketStatus } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketStatus';
import { ticketRepositoryLive } from '~/Infrastructure/Tickets/TicketRepository/fromSource';

const AppLive = Layer.unwrap(
  harnessConfig.pipe(
    Effect.flatMap((config) => resolveTicketSource(config.source, 'folder')),
    Effect.map((source) => ticketRepositoryLive(source))
  )
).pipe(Layer.provide(ConfigProvider.layer(harnessConfigProvider(harnessFileConfig))));

const Count = Schema.Int.check(Schema.isGreaterThan(0));

const command = Command.make(
  'generate',
  {
    count: Flag.integer('count').pipe(Flag.withSchema(Count), Flag.withDefault(12)),
    kind: Flag.choice('kind', TicketKind.literals).pipe(Flag.atLeast(0)),
    status: Flag.choice('status', TicketStatus.literals).pipe(Flag.atLeast(0)),
    hitl: Flag.choice('hitl', Hitl.literals).pipe(Flag.atLeast(0)),
    project: Flag.string('project').pipe(Flag.atLeast(0)),
    chain: Flag.boolean('chain').pipe(Flag.withDefault(false)),
  },
  ({ chain, count, hitl, kind, project, status }) =>
    generateTickets({ count, kinds: kind, statuses: status, hitls: hitl, projects: project, chain }).pipe(
      Effect.flatMap((created) => Console.log(`Generated ${created} ticket file(s)`)),
      Effect.catchTag('NoTicketMatchesConstraints', () =>
        Console.error('No ticket kind matches the given kind and hitl constraints')
      )
    )
);

export const program = Command.run(command, { version: '0.0.1' }).pipe(
  Effect.provide(AppLive.pipe(Layer.provideMerge(NodeServices.layer)))
);

const describeError = (error: unknown) =>
  error instanceof Config.ConfigError ? error.cause.message : error;

if (import.meta.main) {
  program.pipe(
    Effect.tapError((error) => Effect.logError(describeError(error))),
    NodeRuntime.runMain({ disableErrorReporting: true })
  );
}
