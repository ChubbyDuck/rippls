import { Effect, Layer, Schema } from 'effect';
import { expect, test } from 'vitest';

import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { WorktreeRepository } from '~/Core/Tickets/Ports/WorktreeRepository';

import { resolveAnchor } from './resolveAnchor';

const ticketId = Schema.decodeSync(TicketId)('folder:1');

const unusedProject = Layer.succeed(WorktreeRepository, {
  projectAnchor: () => Effect.die('projectAnchor should not be called'),
  ticketAnchor: ({ id }) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/ticket-${id}`, branch: `ticket-${id}` }),
  close: () => Effect.die('close should not be called'),
});

test('a ticket with no project resolves to a ticket worktree', () => {
  const requested: TicketId[] = [];
  const services = Layer.succeed(WorktreeRepository, {
    projectAnchor: () => Effect.die('projectAnchor should not be called'),
    ticketAnchor: ({ id }) =>
      Effect.sync(() => {
        requested.push(id);
        return { path: `/repo/.sandcastle/worktrees/ticket-${id}`, branch: `ticket-${id}` };
      }),
    close: () => Effect.die('close should not be called'),
  });

  expect(
    Effect.runSync(resolveAnchor({ ticket: { id: ticketId } }).pipe(Effect.provide(services)))
  ).toEqual({ path: '/repo/.sandcastle/worktrees/ticket-folder:1', branch: 'ticket-folder:1' });
  expect(requested).toEqual([ticketId]);
});

test('a ticket with a project creates the project worktree then the ticket worktree', () => {
  const project = Schema.decodeSync(Project)('demo');
  const projects: Project[] = [];
  const tickets: TicketId[] = [];
  const services = Layer.succeed(WorktreeRepository, {
    projectAnchor: (value) =>
      Effect.sync(() => {
        projects.push(value);
        return { path: '/repo/.sandcastle/worktrees/demo', branch: 'demo' };
      }),
    ticketAnchor: ({ id, project: named }) =>
      Effect.sync(() => {
        tickets.push(id);
        expect(named).toBe(project);
        return { path: `/repo/.sandcastle/worktrees/ticket-${id}`, branch: `ticket-${id}` };
      }),
    close: () => Effect.die('close should not be called'),
  });

  expect(
    Effect.runSync(resolveAnchor({ ticket: { id: ticketId, project } }).pipe(Effect.provide(services)))
  ).toEqual({ path: '/repo/.sandcastle/worktrees/ticket-folder:1', branch: 'ticket-folder:1' });
  expect(projects).toEqual([project]);
  expect(tickets).toEqual([ticketId]);
});

test('a ticket with no project does not create a project worktree', () => {
  expect(
    Effect.runSync(resolveAnchor({ ticket: { id: ticketId } }).pipe(Effect.provide(unusedProject)))
  ).toEqual({ path: '/repo/.sandcastle/worktrees/ticket-folder:1', branch: 'ticket-folder:1' });
});
