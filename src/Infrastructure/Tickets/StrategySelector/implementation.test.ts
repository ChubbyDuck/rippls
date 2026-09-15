import { Effect, Result } from 'effect';
import { expect, test } from 'vitest';

import { HarnessRuntimeError } from '~/Core/Shared/Domain/Exceptions/HarnessRuntimeError';
import type { Harness, HarnessRunOptions, HarnessRunResult } from '~/Core/Shared/Ports/Harness';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { gateCircumstances, worktreeCircumstances } from './circumstances';
import { implementationStrategy } from './implementation';

const ticket = Ticket.create({
  id: formatTicketId('folder', '7'),
  title: 'Deliver a green ticket',
  project: 'test',
  kind: 'implementation',
  status: 'ready-for-agent',
  blockedBy: [],
  blocks: [],
  body: 'BODY',
});

type Handler = (prompt: string, options: HarnessRunOptions) => Effect.Effect<HarnessRunResult, HarnessRuntimeError>;

const harnessOf = (handler: Handler): { harness: Harness; calls: { prompt: string; label: string }[] } => {
  const calls: { prompt: string; label: string }[] = [];
  const harness: Harness = {
    name: 'Mock',
    model: 'test-model',
    run: (prompt, options) =>
      Effect.suspend(() => {
        calls.push({ prompt, label: options.label });
        return handler(prompt, options);
      }),
  };
  return { harness, calls };
};

const gateSignals = (signals: (string | undefined)[]): Handler => {
  let index = 0;
  return (_prompt, options) =>
    Effect.succeed({
      completionSignal: options.completionSignal === undefined ? undefined : signals[index++],
    });
};

test('runs implement, gate, then commit and reports success when the gate passes', async () => {
  const { harness, calls } = harnessOf(gateSignals(['GATE:PASS']));

  const outcome = await Effect.runPromise(implementationStrategy.run(ticket, harness));

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(calls.map((call) => call.label)).toEqual(['ticket-folder:7-implement', 'ticket-folder:7-gate', 'ticket-folder:7-commit']);
  expect(calls[0]!.prompt).toBe(`/implement-bare BODY\n\n${worktreeCircumstances}`);
  expect(calls[1]!.prompt).toBe(
    `/acceptance-gate BODY\n\n${gateCircumstances}\n\n` +
      'When you finish, print exactly "GATE:PASS" if every gate passed. Otherwise print exactly "GATE:FAIL".'
  );
  expect(calls[2]!.prompt).toBe('/commit test ticket-folder:7');
});

test('commits with only the ticket number when the ticket has no project', async () => {
  const ticketWithoutProject = Ticket.create({
    id: formatTicketId('folder', '7'),
    title: 'Deliver a green ticket',
    kind: 'implementation',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: 'BODY',
  });
  const { harness, calls } = harnessOf(gateSignals(['GATE:PASS']));

  const outcome = await Effect.runPromise(implementationStrategy.run(ticketWithoutProject, harness));

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(calls[2]!.prompt).toBe('/commit ticket-folder:7');
});

test('retries the gate once and commits when the second attempt passes', async () => {
  const { harness, calls } = harnessOf(gateSignals(['GATE:FAIL', 'GATE:PASS']));

  const outcome = await Effect.runPromise(implementationStrategy.run(ticket, harness));

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(calls.map((call) => call.label)).toEqual([
    'ticket-folder:7-implement',
    'ticket-folder:7-gate',
    'ticket-folder:7-gate',
    'ticket-folder:7-commit',
  ]);
});

test('reports failure and does not commit when the gate fails twice', async () => {
  const { harness, calls } = harnessOf(gateSignals(['GATE:FAIL', 'GATE:FAIL']));

  const outcome = await Effect.runPromise(implementationStrategy.run(ticket, harness));

  expect(Result.isFailure(outcome)).toBe(true);
  expect(calls.map((call) => call.label)).toEqual(['ticket-folder:7-implement', 'ticket-folder:7-gate', 'ticket-folder:7-gate']);
});

test('reports failure and does not run the gate when implement crashes', async () => {
  const { harness, calls } = harnessOf((_prompt, options) =>
    options.label.endsWith('-implement') ? Effect.fail(new HarnessRuntimeError()) : Effect.succeed({ completionSignal: 'GATE:PASS' })
  );

  const outcome = await Effect.runPromise(implementationStrategy.run(ticket, harness));

  expect(Result.isFailure(outcome)).toBe(true);
  expect(calls.map((call) => call.label)).toEqual(['ticket-folder:7-implement']);
});
