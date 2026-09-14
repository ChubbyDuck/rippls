import { Effect, Layer, Schema } from 'effect';
import { expect, test } from 'vitest';

import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { WorktreeRepository } from './WorktreeRepository';

const project = Schema.decodeSync(Project)('demo');
const ticketId = Schema.decodeSync(TicketId)('folder:17');

test('a use case obtains a project worktree from WorktreeRepository', () => {
  const worktree = { path: '/repo/.sandcastle/worktrees/demo', branch: 'demo' };
  const requested: Project[] = [];
  const services = Layer.succeed(WorktreeRepository, {
    projectAnchor: (value) =>
      Effect.sync(() => {
        requested.push(value);
        return worktree;
      }),
    ticketAnchor: () => Effect.die('ticketAnchor should not be called'),
    close: () => Effect.die('close should not be called'),
  });

  const result = Effect.runSync(
    Effect.gen(function* () {
      const repo = yield* WorktreeRepository;
      return yield* repo.projectAnchor(project);
    }).pipe(Effect.provide(services))
  );

  expect(requested).toEqual([project]);
  expect(result).toEqual(worktree);
});

test('a use case obtains a ticket worktree from WorktreeRepository', () => {
  const worktree = { path: '/repo/.sandcastle/worktrees/ticket-17', branch: 'ticket-17' };
  const requested: TicketId[] = [];
  const services = Layer.succeed(WorktreeRepository, {
    projectAnchor: () => Effect.die('projectAnchor should not be called'),
    ticketAnchor: ({ id }) =>
      Effect.sync(() => {
        requested.push(id);
        return worktree;
      }),
    close: () => Effect.die('close should not be called'),
  });

  const result = Effect.runSync(
    Effect.gen(function* () {
      const repo = yield* WorktreeRepository;
      return yield* repo.ticketAnchor({ id: ticketId, project });
    }).pipe(Effect.provide(services))
  );

  expect(requested).toEqual([ticketId]);
  expect(result).toEqual(worktree);
});

test('a use case closes a ticket worktree through WorktreeRepository', () => {
  const worktree = { path: '/repo/.sandcastle/worktrees/ticket-17', branch: 'ticket-17' };
  const closed: string[] = [];
  const services = Layer.succeed(WorktreeRepository, {
    projectAnchor: () => Effect.die('projectAnchor should not be called'),
    ticketAnchor: () => Effect.die('ticketAnchor should not be called'),
    close: (value) =>
      Effect.sync(() => {
        closed.push(value.path);
      }),
  });

  Effect.runSync(
    Effect.gen(function* () {
      const repo = yield* WorktreeRepository;
      yield* repo.close(worktree);
    }).pipe(Effect.provide(services))
  );

  expect(closed).toEqual([worktree.path]);
});
