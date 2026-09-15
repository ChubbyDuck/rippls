import { Effect, Layer, Schema } from 'effect';
import { expect, test } from 'vitest';

import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { WorktreeManager } from './WorktreeManager';

const project = Schema.decodeSync(Project)('demo');
const ticketId = Schema.decodeSync(TicketId)('folder:17');

test('a use case obtains a project worktree from WorktreeManager', () => {
  const worktree = { path: '/repo/.sandcastle/worktrees/demo', branch: 'demo' };
  const requested: Project[] = [];
  const services = Layer.succeed(WorktreeManager, {
    prepareProject: (value) =>
      Effect.sync(() => {
        requested.push(value);
        return worktree;
      }),
    prepareTicket: () => Effect.die('prepareTicket should not be called'),
    mergeAndClose: () => Effect.die('mergeAndClose should not be called'),
  });

  const result = Effect.runSync(
    Effect.gen(function* () {
      const manager = yield* WorktreeManager;
      return yield* manager.prepareProject(project);
    }).pipe(Effect.provide(services))
  );

  expect(requested).toEqual([project]);
  expect(result).toEqual(worktree);
});

test('a use case obtains a ticket worktree from WorktreeManager', () => {
  const worktree = { path: '/repo/.sandcastle/worktrees/ticket-17', branch: 'ticket-17' };
  const requested: TicketId[] = [];
  const services = Layer.succeed(WorktreeManager, {
    prepareProject: () => Effect.die('prepareProject should not be called'),
    prepareTicket: ({ id }) =>
      Effect.sync(() => {
        requested.push(id);
        return worktree;
      }),
    mergeAndClose: () => Effect.die('mergeAndClose should not be called'),
  });

  const result = Effect.runSync(
    Effect.gen(function* () {
      const manager = yield* WorktreeManager;
      return yield* manager.prepareTicket({ id: ticketId, project });
    }).pipe(Effect.provide(services))
  );

  expect(requested).toEqual([ticketId]);
  expect(result).toEqual(worktree);
});

test('a use case closes a ticket worktree through WorktreeManager', () => {
  const worktree = { path: '/repo/.sandcastle/worktrees/ticket-17', branch: 'ticket-17' };
  const closed: string[] = [];
  const services = Layer.succeed(WorktreeManager, {
    prepareProject: () => Effect.die('prepareProject should not be called'),
    prepareTicket: () => Effect.die('prepareTicket should not be called'),
    mergeAndClose: (value) =>
      Effect.sync(() => {
        closed.push(value.path);
      }),
  });

  Effect.runSync(
    Effect.gen(function* () {
      const manager = yield* WorktreeManager;
      yield* manager.mergeAndClose(worktree);
    }).pipe(Effect.provide(services))
  );

  expect(closed).toEqual([worktree.path]);
});
