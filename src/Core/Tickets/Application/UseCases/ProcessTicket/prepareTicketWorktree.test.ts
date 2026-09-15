import { Effect, Layer, Schema } from 'effect';
import { expect, test } from 'vitest';

import { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';
import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

import { prepareTicketWorktree } from './prepareTicketWorktree';

const ticketId = Schema.decodeSync(TicketId)('folder:1');

const unusedProject = Layer.succeed(WorktreeManager, {
  prepareProject: () => Effect.die('prepareProject should not be called'),
  prepareTicket: ({ id }) => Effect.succeed({ path: `/repo/.sandcastle/worktrees/ticket-${id}`, branch: `ticket-${id}` }),
  mergeAndClose: () => Effect.die('mergeAndClose should not be called'),
});

test('a ticket with no project resolves to a ticket worktree', () => {
  const requested: TicketId[] = [];
  const services = Layer.succeed(WorktreeManager, {
    prepareProject: () => Effect.die('prepareProject should not be called'),
    prepareTicket: ({ id }) =>
      Effect.sync(() => {
        requested.push(id);
        return { path: `/repo/.sandcastle/worktrees/ticket-${id}`, branch: `ticket-${id}` };
      }),
    mergeAndClose: () => Effect.die('mergeAndClose should not be called'),
  });

  expect(
    Effect.runSync(prepareTicketWorktree({ ticket: { id: ticketId } }).pipe(Effect.provide(services)))
  ).toEqual({ path: '/repo/.sandcastle/worktrees/ticket-folder:1', branch: 'ticket-folder:1' });
  expect(requested).toEqual([ticketId]);
});

test('a ticket with a project creates the project worktree then the ticket worktree', () => {
  const project = Schema.decodeSync(Project)('demo');
  const projects: Project[] = [];
  const tickets: TicketId[] = [];
  const services = Layer.succeed(WorktreeManager, {
    prepareProject: (value) =>
      Effect.sync(() => {
        projects.push(value);
        return { path: '/repo/.sandcastle/worktrees/demo', branch: 'demo' };
      }),
    prepareTicket: ({ id, project: named }) =>
      Effect.sync(() => {
        tickets.push(id);
        expect(named).toBe(project);
        return { path: `/repo/.sandcastle/worktrees/ticket-${id}`, branch: `ticket-${id}` };
      }),
    mergeAndClose: () => Effect.die('mergeAndClose should not be called'),
  });

  expect(
    Effect.runSync(prepareTicketWorktree({ ticket: { id: ticketId, project } }).pipe(Effect.provide(services)))
  ).toEqual({ path: '/repo/.sandcastle/worktrees/ticket-folder:1', branch: 'ticket-folder:1' });
  expect(projects).toEqual([project]);
  expect(tickets).toEqual([ticketId]);
});

test('a ticket with no project does not create a project worktree', () => {
  expect(
    Effect.runSync(prepareTicketWorktree({ ticket: { id: ticketId } }).pipe(Effect.provide(unusedProject)))
  ).toEqual({ path: '/repo/.sandcastle/worktrees/ticket-folder:1', branch: 'ticket-folder:1' });
});
